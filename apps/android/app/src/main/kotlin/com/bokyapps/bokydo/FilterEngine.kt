package com.bokyapps.bokydo

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.TimeUnit

/**
 * The web's saved-filter engine (`packages/filter-query`, bundled into `assets/filter.js`)
 * running in the same JavaScript sandbox as the quick-add parser (ADR 0016). JSON in, JSON
 * out: the request carries the query and the synced data, the answer carries the tasks that
 * match. The parser and the evaluator are the web's own, so a filter saved on the web behaves
 * the same on the phone.
 *
 * Filters run over the data on the device, so they work offline. If the sandbox isn't
 * available the screen says so instead of showing the wrong tasks.
 */
class FilterEngine(private val runtime: JsRuntime) {
    private val lock = Mutex()
    private var failures = 0

    /** False once the sandbox is known not to work here. */
    @Volatile
    var available: Boolean = runtime.supported
        private set

    /** The engine's answer for [requestJson], or null when it isn't available. */
    suspend fun run(requestJson: String): String? {
        if (!available) return null
        return withContext(Dispatchers.IO) {
            lock.withLock {
                try {
                    val iso = runtime.isolate("filter.js")
                    iso.evaluateJavaScriptAsync("bokydoFilter(${JsonPrimitive(requestJson)})").get(TIMEOUT_S, TimeUnit.SECONDS)
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
