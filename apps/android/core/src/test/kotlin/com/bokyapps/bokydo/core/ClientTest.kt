package com.bokyapps.bokydo.core

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

class FakeSessions(var session: Session? = null) : SessionStore {
    override fun load() = session
    override fun save(session: Session) {
        this.session = session
    }
    override fun clear() {
        session = null
    }
}

private fun syncBody(cursor: String, vararg extra: Pair<String, String>) =
    """{"cursor":"$cursor","fullSync":false,"user":{"id":"u"},"projects":[],"sections":[],"tasks":[],"labels":[],"filters":[],"comments":[],"reminders":[],
        "removed":{"projects":[],"sections":[],"tasks":[],"labels":[],"filters":[],"comments":[],"reminders":[]},
        "collaborators":[],"members":[],"invitations":[],"workspaces":[],"workspaceMembers":[],"folders":[],"notifications":[],"unreadNotifications":0,
        "results":{${extra.joinToString(",") { (k, v) -> "\"$k\":$v" }}}}"""

class ClientTest {
    private lateinit var server: MockWebServer
    private lateinit var origin: String
    private val requests = Collections.synchronizedList(mutableListOf<RecordedRequest>())
    private var now = 1_000_000L
    private val refreshes = AtomicInteger()
    private var refreshAnswer: () -> MockResponse = {
        refreshes.incrementAndGet()
        MockResponse().setBody("""{"access_token":"bkd_at_new","token_type":"Bearer","expires_in":3600,"refresh_token":"bkd_rt_new","scope":"sync"}""")
    }

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when (request.path) {
                    "/.well-known/bokydo" -> MockResponse().setBody(Json.encodeToString(Discovery.serializer(), discoveryFor(origin)))
                    "/oauth/token" -> {
                        val body = request.body.readUtf8()
                        if ("grant_type=authorization_code" in body) {
                            MockResponse().setBody("""{"access_token":"bkd_at_1","token_type":"Bearer","expires_in":3600,"refresh_token":"bkd_rt_1","scope":"sync"}""")
                        } else {
                            Thread.sleep(50)
                            refreshAnswer()
                        }
                    }
                    "/api/v1/sync" ->
                        if (request.getHeader("Authorization") == "Bearer bkd_at_new") MockResponse().setBody(syncBody("7"))
                        else MockResponse().setResponseCode(401).setBody("""{"error":"invalid_access_token"}""")
                    "/redirect" -> MockResponse().setResponseCode(302).setHeader("Location", "https://example.invalid/steal")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        origin = server.url("/").toString().trimEnd('/')
    }

    @After
    fun stop() = server.shutdown()

    private fun signedIn(sessions: FakeSessions, accessExpiresAtMs: Long = now + 3_600_000) {
        sessions.session = Session(origin, discoveryFor(origin), "bkd_at_1", "bkd_rt_1", accessExpiresAtMs, "sync")
    }

    @Test
    fun exchangesTheCodeWithTheVerifierAndStoresTheSession() = runBlocking {
        val sessions = FakeSessions()
        val client = BokyDoClient(sessions, { now })
        val pending = PendingAuth.start(origin, discoveryFor(origin), now)
        client.exchangeCode(pending, "the-code")
        assertEquals("bkd_at_1", sessions.session?.accessToken)
        assertEquals(now + 3_600_000, sessions.session?.accessExpiresAtMs)
        assertEquals(1, requests.count { it.path == "/oauth/token" })
    }

    @Test
    fun refreshesOnceAndRetriesWhenTheAccessTokenIsRefused() = runBlocking {
        val sessions = FakeSessions().also { signedIn(it) }
        val client = BokyDoClient(sessions, { now })
        val res = client.sync(SyncRequest(null))
        assertEquals("7", res.cursor)
        assertEquals(1, refreshes.get())
        assertEquals("bkd_rt_new", sessions.session?.refreshToken)
        val syncCalls = requests.filter { it.path == "/api/v1/sync" }.map { it.getHeader("Authorization") }
        assertEquals(listOf("Bearer bkd_at_1", "Bearer bkd_at_new"), syncCalls)
    }

    @Test
    fun refreshesOneAtATimeEvenWhenManyCallsNeedIt() = runBlocking {
        val sessions = FakeSessions().also { signedIn(it, accessExpiresAtMs = now) }
        val client = BokyDoClient(sessions, { now })
        val tokens = (1..5).map { async(kotlinx.coroutines.Dispatchers.IO) { client.accessToken() } }.awaitAll()
        assertEquals(1, refreshes.get())
        assertTrue(tokens.all { it == "bkd_at_new" })
    }

    @Test
    fun signsOutWhenTheGrantIsGone() = runBlocking {
        refreshAnswer = { MockResponse().setResponseCode(400).setBody("""{"error":"invalid_grant"}""") }
        val sessions = FakeSessions().also { signedIn(it, accessExpiresAtMs = now) }
        val client = BokyDoClient(sessions, { now })
        try {
            client.sync(SyncRequest(null))
            fail("expected sign-out")
        } catch (_: SignedOutException) {
        }
        assertNull(sessions.session)
    }

    @Test
    fun keepsTheSessionOnOtherServerErrors() = runBlocking {
        refreshAnswer = { MockResponse().setResponseCode(503) }
        val sessions = FakeSessions().also { signedIn(it, accessExpiresAtMs = now) }
        val client = BokyDoClient(sessions, { now })
        try {
            client.accessToken()
            fail("expected an error")
        } catch (e: ServerException) {
            assertEquals(503, e.status)
        }
        assertEquals("bkd_rt_1", sessions.session?.refreshToken)
    }

    @Test
    fun neverFollowsRedirects() = runBlocking {
        val client = BokyDoClient(FakeSessions(), { now })
        val res = client.http.newCall(okhttp3.Request.Builder().url("$origin/redirect").build()).execute()
        assertEquals(302, res.code)
        res.close()
        assertEquals(1, requests.size)
    }

    @Test
    fun discoversTheServer() = runBlocking {
        val client = BokyDoClient(FakeSessions(), { now })
        val address = (ServerAddress.parse(origin) as ServerAddress.Result.Ok).address
        assertEquals(DiscoveryCheck.Ok, client.discover(address).check(address))
    }
}

class SyncEngineTest {
    private fun response(cursor: String, full: Boolean = false, tasks: List<JsonObject> = emptyList(), removedTasks: List<String> = emptyList(), results: Map<String, CommandResult> = emptyMap()) =
        SyncResponse(
            cursor = cursor,
            fullSync = full,
            entities = ENTITY_TYPES.associateWith { if (it == "tasks") tasks else emptyList() },
            removed = ENTITY_TYPES.associateWith { if (it == "tasks") removedTasks else emptyList() },
            snapshots = emptyMap(),
            results = results,
        )

    private fun task(id: String, content: String) = JsonObject(mapOf("id" to JsonPrimitive(id), "content" to JsonPrimitive(content)))

    @Test
    fun mergesDeltasAndReplacesOnFullSync() {
        val store = MemoryStore()
        store.apply(response("1", full = true, tasks = listOf(task("a", "A"), task("b", "B"))), emptyList())
        store.apply(response("2", tasks = listOf(task("a", "A2")), removedTasks = listOf("b")), emptyList())
        assertEquals(mapOf("a" to "A2"), store.entities.getValue("tasks").mapValues { (it.value["content"] as JsonPrimitive).content })
        store.apply(response("3", full = true, tasks = listOf(task("c", "C"))), emptyList())
        assertEquals(setOf("c"), store.entities.getValue("tasks").keys)
        assertEquals("3", store.cursor())
    }

    @Test
    fun dropsAnsweredCommandsAndKeepsRejections() {
        val store = MemoryStore()
        val ok = Command("task_add", "u1", JsonObject(emptyMap()))
        val bad = Command("task_add", "u2", JsonObject(emptyMap()))
        val unanswered = Command("task_add", "u3", JsonObject(emptyMap()))
        listOf(ok, bad, unanswered).forEach(store::enqueue)
        store.apply(
            response("1", results = mapOf("u1" to CommandResult(true), "u2" to CommandResult(false, "forbidden"))),
            listOf(ok, bad, unanswered),
        )
        assertEquals(listOf(unanswered), store.pending(10))
        assertEquals(listOf("forbidden"), store.rejected().map { it.error })
    }

    @Test
    fun keepsTheQueueWhenTheServerCantBeReached() = runBlocking {
        val store = MemoryStore()
        store.enqueue(Command("task_add", "u1", JsonObject(emptyMap())))
        val dead = BokyDoClient(FakeSessions(Session("http://127.0.0.1:9", discoveryFor("http://127.0.0.1:9"), "a", "r", Long.MAX_VALUE, "sync")))
        try {
            SyncEngine(dead, store).sync()
            fail("expected a network error")
        } catch (_: java.io.IOException) {
        }
        assertEquals(1, store.pending(10).size)
    }

    @Test
    fun generatesTimeOrderedUuids() {
        val a = Ids.newId(1_000)
        val b = Ids.newId(2_000)
        assertEquals('7', a[14])
        assertTrue(a < b)
    }
}
