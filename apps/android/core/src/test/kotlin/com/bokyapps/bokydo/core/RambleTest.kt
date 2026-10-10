package com.bokyapps.bokydo.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
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

class RambleTest {
    private lateinit var server: MockWebServer
    private lateinit var origin: String
    private val requests = Collections.synchronizedList(mutableListOf<RecordedRequest>())
    private lateinit var api: RambleApi

    private val extractBody = """{"draft":[
        {"ref":"d1","content":"Call Ana","due":"tomorrow 3pm","priority":1,"project":"Work","labels":["phone"],
         "resolved":{"projectId":"work","sectionId":null,"due":{"date":"2026-10-08","time":"15:00","timezone":null,"string":"tomorrow 3pm","recurrence":null},"labels":["phone"],"assigneeId":null,"issues":[]}},
        {"ref":"d2"},
        {"ref":"d3","content":"Buy milk","resolved":{"projectId":null,"sectionId":null,"due":null,"labels":[],"assigneeId":null,"issues":["unknown_project","new_label"]}}],
        "ops":[{"op":"add","ref":"d1"},{"op":"add","ref":"d3"}]}"""

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when {
                    request.path?.startsWith("/api/v1/ramble/transcribe") == true ->
                        MockResponse().setBody("""{"text":"call Ana tomorrow"}""")
                    request.path == "/api/v1/ramble/extract" -> MockResponse().setBody(extractBody)
                    request.path == "/api/v1/ramble/commit" ->
                        MockResponse().setResponseCode(201).setBody("""{"created":[{"ref":"d1","taskId":"t1"}]}""")
                    request.path == "/api/v1/ramble/deny" ->
                        MockResponse().setResponseCode(403).setBody("""{"error":"insufficient_scope"}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        origin = server.url("/").toString().trimEnd('/')
        val sessions = FakeSessions(Session(origin, discoveryFor(origin), "bkd_at_1", "bkd_rt_1", Long.MAX_VALUE, "sync"))
        api = RambleApi(BokyDoClient(sessions))
    }

    @After
    fun stop() = server.shutdown()

    @Test
    fun transcribeSendsBytesAndQueryAndReadsText(): Unit = runBlocking {
        val text = api.transcribe(byteArrayOf(1, 2, 3), "audio/mp4", 3.5, "en")
        assertEquals("call Ana tomorrow", text)
        val req = requests.single { it.path?.startsWith("/api/v1/ramble/transcribe") == true }
        assertEquals("/api/v1/ramble/transcribe?seconds=3.5&language=en", req.path)
        assertEquals("Bearer bkd_at_1", req.getHeader("Authorization"))
        assertTrue((req.getHeader("Content-Type") ?: "").startsWith("audio/mp4"))
        assertEquals(3, req.body.size)
    }

    @Test
    fun transcribeWithoutLanguageOmitsTheParam(): Unit = runBlocking {
        api.transcribe(byteArrayOf(1), "audio/webm", 1.0, null)
        assertTrue(requests.any { it.path == "/api/v1/ramble/transcribe?seconds=1.0" })
    }

    @Test
    fun transcribeRejectsBadInputBeforeAnyCall(): Unit = runBlocking {
        val before = requests.size
        for (bad in listOf<suspend () -> Unit>(
            { api.transcribe(byteArrayOf(), "audio/mp4", 1.0, null) },
            { api.transcribe(ByteArray(RAMBLE_MAX_AUDIO_BYTES + 1), "audio/mp4", 1.0, null) },
            { api.transcribe(byteArrayOf(1), "video/mp4", 1.0, null) },
            { api.transcribe(byteArrayOf(1), "audio/mp4", 0.0, null) },
            { api.transcribe(byteArrayOf(1), "audio/mp4", 61.0, null) },
            { api.transcribe(byteArrayOf(1), "audio/mp4", 1.0, "EN") },
            { api.transcribe(byteArrayOf(1), "audio/mp4", 1.0, "e") },
        )) {
            try {
                bad()
                fail("expected IllegalArgumentException")
            } catch (_: IllegalArgumentException) {
            }
        }
        assertEquals(before, requests.size)
    }

    @Test
    fun extractDecodesDraftSkipsBrokenAndKeepsRaw(): Unit = runBlocking {
        val draft = api.extract("call Ana tomorrow", JsonArray(emptyList()))
        assertEquals(listOf("d1", "d3"), draft.tasks.map { it.ref })
        val first = draft.tasks[0]
        assertEquals("Call Ana", first.content)
        assertEquals("2026-10-08", first.resolution?.due?.date)
        assertEquals("work", first.resolution?.projectId)
        assertEquals(listOf("unknown_project", "new_label"), draft.tasks[1].resolution?.issues)
        assertEquals(listOf("add" to "d1", "add" to "d3"), draft.ops.map { it.op to it.ref })
        // The raw draft round-trips verbatim for the next call.
        assertEquals(3, draft.raw.size)
        val sent = requests.single { it.path == "/api/v1/ramble/extract" }
        val body = Json.parseToJsonElement(sent.body.readUtf8()) as JsonObject
        assertEquals("call Ana tomorrow", (body["text"] as JsonPrimitive).content)
    }

    @Test
    fun commitDecodesCreated(): Unit = runBlocking {
        val tasks = JsonArray(listOf(JsonObject(mapOf("ref" to JsonPrimitive("d1"), "content" to JsonPrimitive("Call Ana")))))
        val created = api.commit(tasks)
        assertEquals(listOf(RambleCreated("d1", "t1")), created)
    }

    @Test
    fun commitNeedsOneToFiftyTasks(): Unit = runBlocking {
        val before = requests.size
        try {
            api.commit(JsonArray(emptyList()))
            fail("expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
        }
        assertEquals(before, requests.size)
    }

    @Test
    fun serverRefusalsSurface(): Unit = runBlocking {
        val client = BokyDoClient(FakeSessions(Session(origin, discoveryFor(origin), "bkd_at_1", "bkd_rt_1", Long.MAX_VALUE, "sync")))
        try {
            client.call("POST", "/api/v1/ramble/deny", JsonObject(emptyMap()))
            fail("expected ServerException")
        } catch (e: ServerException) {
            assertEquals(403, e.status)
            assertEquals("insufficient_scope", e.error)
        }
    }

    @Test
    fun projectOverridesSetOrClearTheKey() {
        val task = JsonObject(mapOf("ref" to JsonPrimitive("d1"), "content" to JsonPrimitive("x")))
        assertEquals("work", (task.withProjectId("work")["projectId"] as JsonPrimitive).content)
        assertNull(task.withProjectId(null)["projectId"])
        assertEquals("x", (task.withProjectId(null)["content"] as JsonPrimitive).content)
        val draft = JsonArray(listOf(task, JsonObject(mapOf("ref" to JsonPrimitive("d2"), "content" to JsonPrimitive("y")))))
        val payload = commitTasks(draft, mapOf("d1" to "work"))
        assertEquals("work", ((payload[0] as JsonObject)["projectId"] as JsonPrimitive).content)
        assertNull((payload[1] as JsonObject)["projectId"])
        val cleared = commitTasks(draft, mapOf("d1" to null))
        assertNull((cleared[0] as JsonObject)["projectId"])
    }
}
