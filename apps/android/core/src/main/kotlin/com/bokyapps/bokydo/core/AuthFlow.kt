package com.bokyapps.bokydo.core

import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

private val random = SecureRandom()
private val b64 = Base64.getUrlEncoder().withoutPadding()

private fun randomToken(): String = ByteArray(32).also(random::nextBytes).let(b64::encodeToString)

/** PKCE (RFC 7636, S256 only). */
object Pkce {
    fun verifier(): String = randomToken()
    fun challenge(verifier: String): String =
        b64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
}

/**
 * A sign-in in progress: what the app needs to accept the redirect that ends it. It lives only
 * until that redirect (or 10 minutes) and is used once.
 */
@Serializable
data class PendingAuth(
    val origin: String,
    val discovery: Discovery,
    val state: String,
    val verifier: String,
    val startedAtMs: Long,
) {
    fun authorizationUrl(): String {
        val q = linkedMapOf(
            "response_type" to "code",
            "client_id" to discovery.android.clientId,
            "redirect_uri" to discovery.android.redirectUri,
            "scope" to discovery.android.scope,
            "state" to state,
            "code_challenge" to Pkce.challenge(verifier),
            "code_challenge_method" to "S256",
            "resource" to origin,
        )
        return discovery.oauth.authorizationEndpoint + "?" +
            q.entries.joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, Charsets.UTF_8)}" }
    }

    fun expired(nowMs: Long): Boolean = nowMs - startedAtMs > TTL_MS || nowMs < startedAtMs

    /**
     * Check the redirect that came back. Anything another app could forge or replay is refused:
     * a different `state`, a different issuer (RFC 9207 mix-up defence), an expired flow.
     */
    fun accept(redirect: String, nowMs: Long): RedirectResult {
        if (expired(nowMs)) return RedirectResult.Failed("This sign-in took too long. Try again.")
        val uri = try {
            URI(redirect)
        } catch (_: Exception) {
            return RedirectResult.Failed("Invalid sign-in response")
        }
        if ("${uri.scheme}:${uri.rawPath ?: ""}" != discovery.android.redirectUri) {
            return RedirectResult.Failed("Invalid sign-in response")
        }
        val params = query(uri.rawQuery)
        if (params["state"] != state) return RedirectResult.Failed("This sign-in response isn't for this app session")
        if (params["iss"] != null && params["iss"] != discovery.oauth.issuer) {
            return RedirectResult.Failed("The response came from a different server")
        }
        params["error"]?.let {
            return if (it == "access_denied") RedirectResult.Denied else RedirectResult.Failed("Sign-in failed ($it)")
        }
        val code = params["code"]?.takeIf { it.isNotEmpty() && it.length <= 200 }
            ?: return RedirectResult.Failed("Invalid sign-in response")
        if (params["iss"] == null) return RedirectResult.Failed("The response didn't say which server sent it")
        return RedirectResult.Code(code)
    }

    companion object {
        const val TTL_MS = 10 * 60_000L

        fun start(origin: String, discovery: Discovery, nowMs: Long) =
            PendingAuth(origin, discovery, randomToken(), Pkce.verifier(), nowMs)

        private fun query(raw: String?): Map<String, String> {
            if (raw.isNullOrEmpty()) return emptyMap()
            val out = mutableMapOf<String, String>()
            for (pair in raw.split('&')) {
                val i = pair.indexOf('=')
                if (i <= 0) continue
                val k = URLDecoder.decode(pair.substring(0, i), Charsets.UTF_8)
                // A repeated parameter is a forgery attempt: drop the response's value entirely.
                if (k in out) return emptyMap()
                out[k] = URLDecoder.decode(pair.substring(i + 1), Charsets.UTF_8)
            }
            return out
        }
    }
}

sealed interface RedirectResult {
    data class Code(val code: String) : RedirectResult
    data object Denied : RedirectResult
    data class Failed(val reason: String) : RedirectResult
}
