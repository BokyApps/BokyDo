package com.bokyapps.bokydo.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** A signed-in server: its discovery document and the OAuth tokens for it. */
@Serializable
data class Session(
    val origin: String,
    val discovery: Discovery,
    val accessToken: String,
    val refreshToken: String,
    val accessExpiresAtMs: Long,
    val scope: String,
) {
    /** Never print tokens (logs, crash reports, debugger summaries). */
    override fun toString(): String = "Session(origin=$origin, scope=$scope)"
}

/** Where the session lives. On Android: encrypted with a key held in the Keystore. */
interface SessionStore {
    fun load(): Session?
    fun save(session: Session)
    fun clear()
}

/** RFC 6749 token response. */
@Serializable
internal data class TokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String,
    @SerialName("expires_in") val expiresIn: Long,
    @SerialName("refresh_token") val refreshToken: String,
    val scope: String = "",
)

@Serializable
internal data class OAuthError(val error: String)
