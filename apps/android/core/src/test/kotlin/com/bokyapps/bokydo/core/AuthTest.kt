package com.bokyapps.bokydo.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.net.URLDecoder

fun discoveryFor(origin: String) = Discovery(
    app = "bokydo",
    version = "1",
    publicUrl = origin,
    oauth = Discovery.OAuthEndpoints(
        issuer = origin,
        authorizationEndpoint = "$origin/oauth/authorize",
        tokenEndpoint = "$origin/oauth/token",
        revocationEndpoint = "$origin/oauth/revoke",
    ),
    android = Discovery.AndroidClient(AppIdentity.CLIENT_ID, AppIdentity.REDIRECT_URI, "sync"),
    api = Discovery.ApiEndpoints("$origin/api/v1/sync", "$origin/api/v1/sync/events"),
)

class ServerAddressTest {
    private fun ok(input: String) = (ServerAddress.parse(input) as ServerAddress.Result.Ok).address
    private fun invalid(input: String) = ServerAddress.parse(input) is ServerAddress.Result.Invalid

    @Test
    fun normalisesToAnOrigin() {
        assertEquals("https://tasks.example.com", ok(" tasks.example.com/ ").origin)
        assertEquals("https://tasks.example.com:8443", ok("https://Tasks.Example.com:8443").origin)
        assertEquals("https://tasks.example.com", ok("https://tasks.example.com:443").origin)
    }

    @Test
    fun allowsPlainHttpOnlyOnTheLocalNetwork() {
        for (local in listOf("http://192.168.1.5:8080", "http://10.0.0.2", "http://nas.local", "http://localhost:8080", "http://172.20.0.1", "http://[::1]:8080")) {
            val a = ok(local)
            assertTrue(local, a.insecure)
        }
        for (public in listOf("http://tasks.example.com", "http://8.8.8.8", "http://172.32.0.1", "http://192.168.1.5.nip.io", "http://010.0.0.1")) {
            assertTrue(public, invalid(public))
        }
    }

    @Test
    fun refusesPathsCredentialsAndOtherSchemes() {
        for (bad in listOf("", "https://u:p@tasks.example.com", "https://tasks.example.com/app", "https://tasks.example.com/?x=1", "https://tasks.example.com#f", "ftp://tasks.example.com", "javascript:alert(1)", "https://")) {
            assertTrue(bad, invalid(bad))
        }
    }
}

class DiscoveryTest {
    private val address = (ServerAddress.parse("https://tasks.example.com") as ServerAddress.Result.Ok).address

    @Test
    fun acceptsOnlyADocumentForTheChosenServer() {
        val d = discoveryFor("https://tasks.example.com")
        assertEquals(DiscoveryCheck.Ok, d.check(address))
        assertEquals(DiscoveryCheck.NotBokyDo, d.copy(app = "other").check(address))
        assertEquals(
            DiscoveryCheck.DifferentAddress("https://other.example.com"),
            d.copy(publicUrl = "https://other.example.com").check(address),
        )
        val stealing = d.copy(oauth = d.oauth.copy(tokenEndpoint = "https://evil.example/token"))
        assertEquals(DiscoveryCheck.Inconsistent, stealing.check(address))
        val lookalike = d.copy(api = d.api.copy(sync = "https://tasks.example.com.evil.example/api"))
        assertEquals(DiscoveryCheck.Inconsistent, lookalike.check(address))
        val otherClient = d.copy(android = d.android.copy(redirectUri = "https://evil.example/cb"))
        assertEquals(DiscoveryCheck.Inconsistent, otherClient.check(address))
    }
}

class AuthFlowTest {
    private val origin = "https://tasks.example.com"
    private val pending = PendingAuth.start(origin, discoveryFor(origin), nowMs = 1_000)
    private val now = 2_000L
    private fun redirect(vararg params: Pair<String, String>) =
        AppIdentity.REDIRECT_URI + "?" + params.joinToString("&") { (k, v) -> "$k=${java.net.URLEncoder.encode(v, Charsets.UTF_8)}" }

    @Test
    fun buildsAPkceAuthorizationRequest() {
        val uri = URI(pending.authorizationUrl())
        val q = uri.rawQuery.split('&').associate {
            val (k, v) = it.split('=', limit = 2)
            k to URLDecoder.decode(v, Charsets.UTF_8)
        }
        assertEquals("$origin/oauth/authorize", "${uri.scheme}://${uri.host}${uri.path}")
        assertEquals("S256", q["code_challenge_method"])
        assertEquals(Pkce.challenge(pending.verifier), q["code_challenge"])
        assertEquals(43, pending.verifier.length)
        assertEquals(pending.state, q["state"])
        assertEquals(AppIdentity.CLIENT_ID, q["client_id"])
        assertEquals(AppIdentity.REDIRECT_URI, q["redirect_uri"])
        assertEquals("sync", q["scope"])
        assertEquals(origin, q["resource"])
    }

    @Test
    fun challengeIsUnpaddedBase64UrlSha256() {
        // Expected value computed independently: node -e "crypto.createHash('sha256').update(v).digest('base64url')"
        assertEquals("NgOwT7ciT2O8EoBQ5pPK4_-4DQI3Nq76-RZ1pQ0RFAU", Pkce.challenge("dBjftJeZ4CVP-mJ92K9qPhwnvnqqjKkWUN4MfO6s3dE"))
    }

    @Test
    fun acceptsOnlyItsOwnRedirect() {
        assertEquals(RedirectResult.Code("abc"), pending.accept(redirect("code" to "abc", "state" to pending.state, "iss" to origin), now))
        assertEquals(RedirectResult.Denied, pending.accept(redirect("error" to "access_denied", "state" to pending.state, "iss" to origin), now))
        val refused = listOf(
            redirect("code" to "abc", "state" to "someone-else", "iss" to origin),
            redirect("code" to "abc", "state" to pending.state, "iss" to "https://evil.example"),
            redirect("code" to "abc", "state" to pending.state),
            redirect("state" to pending.state, "iss" to origin),
            redirect("code" to "abc", "state" to pending.state, "iss" to origin, "code" to "evil"),
            "com.evil.app:/oauth2redirect?code=abc&state=${pending.state}&iss=$origin",
            "${AppIdentity.REDIRECT_URI}/x?code=abc&state=${pending.state}&iss=$origin",
        )
        for (r in refused) assertTrue(r, pending.accept(r, now) is RedirectResult.Failed)
        val late = pending.accept(redirect("code" to "abc", "state" to pending.state, "iss" to origin), 1_000 + PendingAuth.TTL_MS + 1)
        assertTrue(late is RedirectResult.Failed)
    }

    @Test
    fun neverPrintsTokens() {
        val s = Session(origin, discoveryFor(origin), "bkd_at_secret", "bkd_rt_secret", 0, "sync")
        assertTrue(!s.toString().contains("secret"))
    }
}
