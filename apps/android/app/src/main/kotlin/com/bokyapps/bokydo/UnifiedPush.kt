package com.bokyapps.bokydo

import android.app.BroadcastOptions
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.bokyapps.bokydo.core.Json
import com.bokyapps.bokydo.core.ServerException
import com.bokyapps.bokydo.core.WebPush
import com.bokyapps.bokydo.core.WebPushException
import com.bokyapps.bokydo.core.WebPushKeys
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.util.UUID

/** Where instant notifications stand, for the UI. */
sealed interface PushState {
    data object Off : PushState
    data class Registering(val distributor: String) : PushState
    data class On(val distributor: String, val host: String) : PushState
    /** The distributor gave an endpoint the server won't send to (not on the admin's list). */
    data class HostNotAllowed(val distributor: String, val host: String) : PushState
    data class Failed(val distributor: String, val reason: String) : PushState
}

/**
 * Instant notifications through UnifiedPush (ntfy and other distributors; PLAN §9 A3), spoken
 * directly (UnifiedPush Android spec AND_3) rather than through a library. Reminders never depend
 * on it: they are local alarms. Push only brings what happens elsewhere (assignments, mentions,
 * comments) sooner, and nudges a sync.
 *
 * Security: the registration token is random and secret, so another app can't feed us messages
 * or end our registration; messages are RFC 8291-encrypted to a key only this device holds, so a
 * distributor or push server can't read or forge them; the server only sends to push hosts its
 * admin allowed, and ties the registration to this app's sign-in.
 */
object UnifiedPush {
    private const val PREFS = "unifiedpush"
    private const val VAULT_KEYS = "push-keys"
    const val ACTION_REGISTER = "org.unifiedpush.android.distributor.REGISTER"
    const val ACTION_UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER"
    const val ACTION_ACK = "org.unifiedpush.android.distributor.MESSAGE_ACK"

    private val _state = MutableStateFlow<PushState>(PushState.Off)
    val state: StateFlow<PushState> = _state

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(context: Context) {
        val p = prefs(context)
        val d = p.getString("distributor", null) ?: return
        val endpoint = p.getString("endpoint", null)
        _state.value = when (p.getString("status", null)) {
            "on" -> PushState.On(label(context, d), host(endpoint))
            "host" -> PushState.HostNotAllowed(label(context, d), host(endpoint))
            "failed" -> PushState.Failed(label(context, d), p.getString("reason", "") ?: "")
            else -> PushState.Registering(label(context, d))
        }
    }

    /** Installed distributors (package names), other than this app. */
    fun distributors(context: Context): List<String> =
        context.packageManager.queryBroadcastReceivers(Intent(ACTION_REGISTER), PackageManager.MATCH_ALL)
            .map { it.activityInfo.packageName }
            .filter { it != context.packageName }
            .distinct()

    fun label(context: Context, pkg: String): String = runCatching {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    private fun host(endpoint: String?): String = runCatching { java.net.URI(endpoint).host }.getOrNull() ?: ""

    /** Device keys for decrypting pushes, created once and kept in the vault. */
    private fun keys(app: BokyDoApp): WebPushKeys =
        app.vault.get(VAULT_KEYS)?.let(WebPushKeys::decode)
            ?: WebPushKeys.generate().also { app.vault.put(VAULT_KEYS, it.encode()) }

    /** Ask a distributor for an endpoint. Its answer arrives at [UnifiedPushReceiver]. */
    suspend fun register(context: Context, distributor: String) {
        val app = context.app
        val vapid = runCatching {
            ((app.client.call("GET", "/api/v1/push/key") as? JsonObject)?.get("publicKey") as? JsonPrimitive)?.content
        }.getOrNull()
        val token = UUID.randomUUID().toString()
        prefs(context).edit()
            .putString("distributor", distributor)
            .putString("token", token)
            .putString("status", "registering")
            .apply()
        _state.value = PushState.Registering(label(context, distributor))
        val intent = Intent(ACTION_REGISTER).setPackage(distributor)
            .putExtra("token", token)
            .putExtra("application", context.packageName) // older distributors (AND_2)
            .putExtra("message", "BokyDo")
            .apply { if (vapid != null) putExtra("vapid", vapid) }
        send(context, intent)
    }

    /** Stop instant notifications: tell the distributor and the server, forget everything. */
    suspend fun unregister(context: Context, tellServer: Boolean = true) {
        val p = prefs(context)
        val distributor = p.getString("distributor", null)
        val token = p.getString("token", null)
        val endpoint = p.getString("endpoint", null)
        if (distributor != null && token != null) {
            runCatching { send(context, Intent(ACTION_UNREGISTER).setPackage(distributor).putExtra("token", token)) }
        }
        if (tellServer && endpoint != null) {
            runCatching {
                context.app.client.call("DELETE", "/api/v1/push/subscriptions", buildJsonObject { put("endpoint", endpoint) })
            }
        }
        p.edit().clear().apply()
        context.app.vault.put(VAULT_KEYS, null)
        _state.value = PushState.Off
    }

    /** Send to the distributor, letting it know who we are (identity on 14+, a PendingIntent before). */
    private fun send(context: Context, intent: Intent) {
        // The spec's identity proof: an immutable PendingIntent naming a dummy app; the
        // distributor reads its creator package (ours). It grants nothing.
        intent.putExtra(
            "pi",
            PendingIntent.getBroadcast(
                context,
                0,
                Intent("org.unifiedpush.dummy_app").setPackage("org.unifiedpush.dummy_app"),
                PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        if (Build.VERSION.SDK_INT >= 34) {
            context.sendBroadcast(intent, null, BroadcastOptions.makeBasic().setShareIdentityEnabled(true).toBundle())
        } else {
            context.sendBroadcast(intent)
        }
    }

    /** Our current token, or null when not registering/registered. */
    fun token(context: Context): String? = prefs(context).getString("token", null)

    internal suspend fun onNewEndpoint(context: Context, endpoint: String) {
        val app = context.app
        val p = prefs(context)
        val distributor = p.getString("distributor", null) ?: return
        val old = p.getString("endpoint", null)
        if (endpoint.length > 1000 || !endpoint.startsWith("https://")) {
            p.edit().putString("status", "failed").putString("reason", "insecure endpoint").apply()
            _state.value = PushState.Failed(label(context, distributor), "The push server isn't using HTTPS.")
            return
        }
        val keys = keys(app)
        try {
            app.client.call(
                "POST",
                "/api/v1/push/subscriptions",
                buildJsonObject {
                    put("endpoint", endpoint)
                    putJsonObject("keys") {
                        put("p256dh", keys.p256dh)
                        put("auth", keys.auth)
                    }
                },
            )
            if (old != null && old != endpoint) {
                runCatching {
                    app.client.call("DELETE", "/api/v1/push/subscriptions", buildJsonObject { put("endpoint", old) })
                }
            }
            p.edit().putString("endpoint", endpoint).putString("status", "on").apply()
            _state.value = PushState.On(label(context, distributor), host(endpoint))
        } catch (e: ServerException) {
            val notAllowed = e.status == 400 && e.error == "unsupported_push_service"
            p.edit().putString("endpoint", endpoint)
                .putString("status", if (notAllowed) "host" else "failed")
                .putString("reason", "server ${e.status}")
                .apply()
            _state.value = if (notAllowed) {
                PushState.HostNotAllowed(label(context, distributor), host(endpoint))
            } else {
                PushState.Failed(label(context, distributor), "The server refused the registration (${e.status}).")
            }
        } catch (e: Exception) {
            p.edit().putString("status", "failed").putString("reason", "offline").apply()
            _state.value = PushState.Failed(label(context, distributor), "Couldn't reach the server. Try again later.")
        }
    }

    internal fun onMessage(context: Context, body: ByteArray) {
        val app = context.app
        val keys = app.vault.get(VAULT_KEYS)?.let(WebPushKeys::decode) ?: return
        val payload = try {
            Json.parseToJsonElement(String(WebPush.decrypt(body, keys), Charsets.UTF_8)) as? JsonObject
        } catch (_: WebPushException) {
            null // not for us, or tampered with: ignore
        } catch (_: Exception) {
            null
        } ?: return
        fun str(k: String) = (payload[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val title = str("title") ?: return
        Notifier.pushed(context, title, str("body") ?: "", str("tag"))
        // Whatever happened is in the next sync too (and may change reminders).
        app.syncNow()
    }

    internal suspend fun onGone(context: Context, failed: String?) {
        val p = prefs(context)
        val distributor = p.getString("distributor", null)
        p.getString("endpoint", null)?.let { endpoint ->
            runCatching {
                context.app.client.call("DELETE", "/api/v1/push/subscriptions", buildJsonObject { put("endpoint", endpoint) })
            }
        }
        p.edit().clear().apply()
        _state.value = if (failed != null && distributor != null) {
            PushState.Failed(label(context, distributor), failed)
        } else {
            PushState.Off
        }
    }

    internal fun ack(context: Context, token: String, id: String) {
        val distributor = prefs(context).getString("distributor", null) ?: return
        send(context, Intent(ACTION_ACK).setPackage(distributor).putExtra("token", token).putExtra("id", id))
    }
}

/**
 * Messages from the distributor. Exported because distributors are other apps; anything without
 * our current secret token is ignored, so other apps can't drive it.
 */
class UnifiedPushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val token = intent.getStringExtra("token") ?: return
        val mine = UnifiedPush.token(context) ?: return
        if (!java.security.MessageDigest.isEqual(token.toByteArray(), mine.toByteArray())) return
        val result = goAsync()
        context.app.scope.launch {
            try {
                when (intent.action) {
                    "org.unifiedpush.android.connector.NEW_ENDPOINT" ->
                        intent.getStringExtra("endpoint")?.let { UnifiedPush.onNewEndpoint(context, it) }
                    "org.unifiedpush.android.connector.MESSAGE" -> {
                        intent.getByteArrayExtra("bytesMessage")
                            ?.takeIf { it.size in 1..4096 }
                            ?.let { UnifiedPush.onMessage(context, it) }
                        intent.getStringExtra("id")?.takeIf { it.length <= 100 }?.let { UnifiedPush.ack(context, token, it) }
                    }
                    "org.unifiedpush.android.connector.UNREGISTERED" -> UnifiedPush.onGone(context, null)
                    "org.unifiedpush.android.connector.REGISTRATION_FAILED" ->
                        UnifiedPush.onGone(context, "The push app couldn't register (${intent.getStringExtra("reason") ?: "unknown"}).")
                }
            } finally {
                result.finish()
            }
        }
    }
}
