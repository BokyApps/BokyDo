package com.bokyapps.bokydo.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** The refresh token was rejected (revoked, reused or expired): the user must sign in again. */
class SignedOutException : Exception("Signed out")

/** The server answered, but not with what we needed. */
class ServerException(val status: Int, val error: String?) : Exception("HTTP $status ${error ?: ""}")

/**
 * The app's only way to talk to a server. Redirects are never followed (a bearer token must not
 * travel anywhere the user didn't choose), responses are size-capped, and tokens are refreshed
 * one at a time: two concurrent refreshes with the same token look like theft to the server
 * and revoke the whole session (ADR 0008).
 */
class BokyDoClient(
    private val sessions: SessionStore,
    private val clock: () -> Long = System::currentTimeMillis,
    baseClient: OkHttpClient = OkHttpClient(),
) {
    val http: OkHttpClient = baseClient.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(90, TimeUnit.SECONDS)
        .build()
    private val refreshLock = Mutex()

    suspend fun discover(address: ServerAddress): Discovery = withContext(Dispatchers.IO) {
        val res = http.newCall(Request.Builder().url("${address.origin}/.well-known/bokydo").get().build()).execute()
        res.use {
            if (it.code == 404) throw ServerException(404, "not_bokydo_or_not_ready")
            if (!it.isSuccessful) throw ServerException(it.code, null)
            Json.decodeFromString(Discovery.serializer(), it.bodyText())
        }
    }

    /** Finish a sign-in: trade the code (and the PKCE verifier) for tokens. */
    suspend fun exchangeCode(pending: PendingAuth, code: String): Session = withContext(Dispatchers.IO) {
        val form = FormBody.Builder()
            .add("grant_type", "authorization_code")
            .add("code", code)
            .add("redirect_uri", pending.discovery.android.redirectUri)
            .add("client_id", pending.discovery.android.clientId)
            .add("code_verifier", pending.verifier)
            .build()
        val tokens = tokenCall(pending.discovery, form) ?: throw ServerException(400, "invalid_grant")
        Session(
            origin = pending.origin,
            discovery = pending.discovery,
            accessToken = tokens.accessToken,
            refreshToken = tokens.refreshToken,
            accessExpiresAtMs = clock() + tokens.expiresIn * 1000,
            scope = tokens.scope,
        ).also(sessions::save)
    }

    /**
     * A usable access token, refreshing first if it is about to expire. `rejected` is the token a
     * request was just refused with: refresh only if nobody has replaced it in the meantime.
     */
    suspend fun accessToken(rejected: String? = null): String = refreshLock.withLock {
        val session = sessions.load() ?: throw SignedOutException()
        val stale = session.accessExpiresAtMs - clock() < 60_000
        if (!stale && session.accessToken != rejected) return session.accessToken
        val refreshed = withContext(Dispatchers.IO) {
            val form = FormBody.Builder()
                .add("grant_type", "refresh_token")
                .add("refresh_token", session.refreshToken)
                .add("client_id", session.discovery.android.clientId)
                .build()
            tokenCall(session.discovery, form)
        }
        if (refreshed == null) {
            sessions.clear()
            throw SignedOutException()
        }
        val next = session.copy(
            accessToken = refreshed.accessToken,
            refreshToken = refreshed.refreshToken,
            accessExpiresAtMs = clock() + refreshed.expiresIn * 1000,
            scope = refreshed.scope,
        )
        sessions.save(next)
        next.accessToken
    }

    /** Returns null when the grant is no longer valid (invalid_grant); throws on other errors. */
    private fun tokenCall(discovery: Discovery, form: FormBody): TokenResponse? {
        val req = Request.Builder().url(discovery.oauth.tokenEndpoint).post(form).build()
        http.newCall(req).execute().use { res ->
            val body = res.bodyText()
            if (res.isSuccessful) return Json.decodeFromString(TokenResponse.serializer(), body)
            val error = runCatching { Json.decodeFromString(OAuthError.serializer(), body).error }.getOrNull()
            if (res.code == 400 && error == "invalid_grant") return null
            throw ServerException(res.code, error)
        }
    }

    /** One sync round trip, retried once with a refreshed token if the access token was refused. */
    suspend fun sync(request: SyncRequest): SyncResponse {
        val session = sessions.load() ?: throw SignedOutException()
        val body = Json.encodeToString(SyncRequest.serializer(), request).toRequestBody(JSON)
        var token = accessToken()
        for (attempt in 0..1) {
            val res = withContext(Dispatchers.IO) {
                http.newCall(
                    Request.Builder().url(session.discovery.api.sync)
                        .header("Authorization", "Bearer $token")
                        .post(body)
                        .build(),
                ).execute()
            }
            res.use {
                if (it.code == 401 && attempt == 0) {
                    token = accessToken(rejected = token)
                } else {
                    if (!it.isSuccessful) throw ServerException(it.code, errorOf(it))
                    val json = Json.parseToJsonElement(it.bodyText()) as? JsonObject
                        ?: throw ProtocolException("not an object")
                    return SyncResponse.fromJson(json)
                }
            }
        }
        throw ServerException(401, "invalid_access_token")
    }

    /** Sign out: tell the server to end the grant (best effort), then forget everything. */
    suspend fun signOut() {
        val session = sessions.load()
        sessions.clear()
        if (session == null) return
        withContext(Dispatchers.IO) {
            runCatching {
                val form = FormBody.Builder()
                    .add("token", session.refreshToken)
                    .add("client_id", session.discovery.android.clientId)
                    .build()
                http.newCall(Request.Builder().url(session.discovery.oauth.revocationEndpoint).post(form).build())
                    .execute().close()
            }
        }
    }

    private fun errorOf(res: Response): String? =
        runCatching { (Json.parseToJsonElement(res.bodyText()) as JsonObject)["error"]?.toString()?.trim('"') }
            .getOrNull()

    companion object {
        private val JSON = "application/json".toMediaType()
        /** Sync responses can be large (a full sync); anything beyond this is refused. */
        const val MAX_BODY_BYTES = 32L * 1024 * 1024
    }
}

internal fun Response.bodyText(): String {
    val body = body ?: return ""
    val declared = body.contentLength()
    if (declared > BokyDoClient.MAX_BODY_BYTES) throw IOException("response too large")
    val source = body.source()
    if (!source.request(BokyDoClient.MAX_BODY_BYTES + 1)) return source.readUtf8()
    throw IOException("response too large")
}
