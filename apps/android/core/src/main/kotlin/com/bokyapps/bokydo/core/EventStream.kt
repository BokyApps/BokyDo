package com.bokyapps.bokydo.core

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

/**
 * Live updates: the server's event stream sends `poke` whenever something the user can see
 * changed ("call sync now"). It carries no data, only the nudge. The flow ends when the stream
 * closes or fails; the caller reconnects with backoff while the app is in the foreground.
 */
class EventStream(private val client: BokyDoClient, private val sessions: SessionStore) {
    // The server sends a heartbeat every 25 s; a minute of silence means the connection is gone.
    private val http = client.http.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build()

    suspend fun pokes(): Flow<Unit> {
        val token = client.accessToken()
        val url = sessions.load()?.discovery?.api?.events ?: throw SignedOutException()
        return callbackFlow {
            val source = EventSources.createFactory(http).newEventSource(
                Request.Builder().url(url).header("Authorization", "Bearer $token").build(),
                object : EventSourceListener() {
                    override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                        if (type == "poke") trySend(Unit)
                    }

                    override fun onClosed(eventSource: EventSource) {
                        close()
                    }

                    override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                        close(ServerException(response?.code ?: 0, t?.javaClass?.simpleName))
                    }
                },
            )
            awaitClose { source.cancel() }
        }
    }
}
