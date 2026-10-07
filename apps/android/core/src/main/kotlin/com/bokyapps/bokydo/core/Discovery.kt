package com.bokyapps.bokydo.core

import kotlinx.serialization.Serializable

/** The official app's identity on every BokyDo server (see the server's `android/routes.ts`). */
object AppIdentity {
    const val PACKAGE = "com.bokyapps.bokydo"
    const val CLIENT_ID = "bkdc_bokydo-android-app-001"
    const val REDIRECT_URI = "$PACKAGE:/oauth2redirect"
    const val SCOPE = "sync"
}

/** `GET /.well-known/bokydo`. */
@Serializable
data class Discovery(
    val app: String,
    val version: String,
    val publicUrl: String,
    val oauth: OAuthEndpoints,
    val android: AndroidClient,
    val api: ApiEndpoints,
) {
    @Serializable
    data class OAuthEndpoints(
        val issuer: String,
        val authorizationEndpoint: String,
        val tokenEndpoint: String,
        val revocationEndpoint: String,
    )

    @Serializable
    data class AndroidClient(val clientId: String, val redirectUri: String, val scope: String)

    @Serializable
    data class ApiEndpoints(val sync: String, val events: String)

    /**
     * Accept a discovery document only if it describes the server the user chose: same origin,
     * every endpoint on that origin, and the app's fixed client identity. A document that points
     * the token endpoint (or anything else) somewhere else is refused, so a compromised or
     * confused proxy can't redirect the sign-in.
     */
    fun check(expected: ServerAddress): DiscoveryCheck {
        if (app != "bokydo") return DiscoveryCheck.NotBokyDo
        if (publicUrl.trimEnd('/') != expected.origin) return DiscoveryCheck.DifferentAddress(publicUrl)
        val base = expected.origin + "/"
        val endpoints = listOf(
            oauth.authorizationEndpoint,
            oauth.tokenEndpoint,
            oauth.revocationEndpoint,
            api.sync,
            api.events,
        )
        if (oauth.issuer.trimEnd('/') != expected.origin || endpoints.any { !it.startsWith(base) }) {
            return DiscoveryCheck.Inconsistent
        }
        if (android.clientId != AppIdentity.CLIENT_ID || android.redirectUri != AppIdentity.REDIRECT_URI) {
            return DiscoveryCheck.Inconsistent
        }
        return DiscoveryCheck.Ok
    }
}

sealed interface DiscoveryCheck {
    data object Ok : DiscoveryCheck
    data object NotBokyDo : DiscoveryCheck
    /** The server says its address is different (e.g. typed http, server is https). */
    data class DifferentAddress(val publicUrl: String) : DiscoveryCheck
    data object Inconsistent : DiscoveryCheck
}
