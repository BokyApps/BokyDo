package com.bokyapps.bokydo

import android.content.Context
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * The JavaScript sandbox the app runs the web's own parsers in (ADR 0016): the WebView's V8 in
 * a separate, isolated process with no network or file access. One sandbox per process (binding
 * twice fails) and one isolate per script, started on first use and kept: a cold start costs
 * about half a second.
 *
 * Only strings cross over: input goes in as a JSON string, never spliced into code.
 */
class JsRuntime(private val context: Context) {
    private val lock = Mutex()
    private var sandbox: JavaScriptSandbox? = null
    private val isolates = mutableMapOf<String, JavaScriptIsolate>()

    /** False on devices without the sandbox: callers fall back to plain text. */
    val supported: Boolean = JavaScriptSandbox.isSupported()

    /** The isolate running [asset], started on first use. */
    suspend fun isolate(asset: String): JavaScriptIsolate = withContext(Dispatchers.IO) {
        lock.withLock {
            isolates[asset] ?: start(asset).also { isolates[asset] = it }
        }
    }

    private fun start(asset: String): JavaScriptIsolate {
        val sb = sandbox ?: JavaScriptSandbox.createConnectedInstanceAsync(context.applicationContext)
            .get(TIMEOUT_S, TimeUnit.SECONDS).also { sandbox = it }
        val iso = sb.createIsolate()
        val source = context.assets.open(asset).use { it.readBytes().toString(Charsets.UTF_8) }
        iso.evaluateJavaScriptAsync("$source;'ok'").get(TIMEOUT_S, TimeUnit.SECONDS)
        return iso
    }

    /**
     * The sandbox process is gone or broken: drop everything and start fresh next time. The
     * other parser's isolate is dropped too — a new sandbox is the only way back.
     */
    suspend fun reset() {
        lock.withLock {
            isolates.values.forEach { runCatching { it.close() } }
            isolates.clear()
            runCatching { sandbox?.close() }
            sandbox = null
        }
    }

    private companion object {
        const val TIMEOUT_S = 10L
    }
}
