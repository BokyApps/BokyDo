package com.bokyapps.bokydo

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.TimeUnit

/**
 * The web's quick-add parser (`packages/nlp`, bundled into `assets/nlp.js`) running in the
 * JavaScript sandbox (ADR 0016): the WebView's V8 in a separate, isolated process with no
 * network or file access. One sandbox and one isolate per process, started on first use and
 * kept (binding twice fails, and a cold start costs about half a second).
 *
 * Only strings cross over: the input is passed as a JSON string literal, never spliced into
 * code. If the sandbox isn't supported or breaks, quick add keeps working as plain text.
 */
class QuickAddParser(private val runtime: JsRuntime) {
    private val lock = Mutex()
    private var failures = 0

    /** False once the sandbox is known not to work here: callers show plain-text quick add. */
    @Volatile
    var available: Boolean = runtime.supported
        private set

    /** The parser's JSON result for [inputJson], or null when parsing isn't available. */
    suspend fun parse(inputJson: String): String? {
        if (!available) return null
        return withContext(Dispatchers.IO) {
            lock.withLock {
                try {
                    val iso = runtime.isolate("nlp.js")
                    iso.evaluateJavaScriptAsync("bokydoQuickAdd(${JsonPrimitive(inputJson)})").get(TIMEOUT_S, TimeUnit.SECONDS)
                } catch (e: InterruptedException) {
                    throw e
                } catch (_: Exception) {
                    // A crashed or killed sandbox process: start afresh next time (once).
                    runtime.reset()
                    if (++failures >= 2) available = false
                    null
                }
            }
        }
    }

    private companion object {
        const val TIMEOUT_S = 10L
    }
}
