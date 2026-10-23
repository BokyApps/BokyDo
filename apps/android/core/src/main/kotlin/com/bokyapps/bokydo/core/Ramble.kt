package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** One audio chunk the server will transcribe (server `RAMBLE_LIMITS`). */
const val RAMBLE_MAX_AUDIO_BYTES = 5 * 1024 * 1024
const val RAMBLE_MAX_AUDIO_SECONDS = 60.0
const val RAMBLE_MAX_TEXT_CHARS = 20_000
const val RAMBLE_MAX_DRAFT = 50

/** What a draft task resolved to, if committed now (names the UI can look up). */
data class RambleResolution(
    val projectId: String?,
    val sectionId: String?,
    val due: Due?,
    val labels: List<String>,
    val assigneeId: String?,
    val issues: List<String>,
)

/** A task in the review draft: what was said, plus what it would become. */
data class RambleDraftTask(
    val ref: String,
    val content: String,
    val description: String?,
    val duePhrase: String?,
    val priority: Int?,
    val project: String?,
    val section: String?,
    val labels: List<String>,
    val assignee: String?,
    val resolution: RambleResolution?,
)

data class RambleOp(val op: String, val ref: String)

/**
 * The review draft. [raw] is the server's JSON, kept verbatim and sent back with the next
 * piece of transcript; [tasks] is the lenient decode the review sheet shows (malformed
 * entries are skipped, never breaking the sheet).
 */
data class RambleDraft(val raw: JsonArray, val tasks: List<RambleDraftTask>, val ops: List<RambleOp>)

data class RambleCreated(val ref: String, val taskId: String)

/**
 * The server's Ramble endpoints (ADR 0014): audio or text in, a draft to review, then one
 * all-or-nothing commit. Nothing is created before the user confirms the draft.
 */
class RambleApi(private val client: BokyDoClient) {
    /** Send one recorded chunk, get its transcript. [seconds] is the chunk length as recorded. */
    suspend fun transcribe(audio: ByteArray, mime: String, seconds: Double, language: String?): String {
        require(audio.isNotEmpty() && audio.size <= RAMBLE_MAX_AUDIO_BYTES) { "audio must be 1 byte to 5 MiB" }
        require(mime.startsWith("audio/")) { "not an audio MIME type" }
        require(seconds > 0 && seconds <= RAMBLE_MAX_AUDIO_SECONDS) { "seconds must be within (0, 60]" }
        require(language == null || language.matches(Regex("^[a-z]{2,3}$"))) { "bad language tag" }
        val query = buildString {
            append("/api/v1/ramble/transcribe?seconds=").append(seconds)
            if (language != null) append("&language=").append(language)
        }
        val res = client.postBytes(query, audio, mime) as? JsonObject
            ?: throw ProtocolException("transcribe answered nothing")
        return res.str("text") ?: throw ProtocolException("transcribe answered without text")
    }

    /** Send new transcript (a voice chunk's text, or pasted text) with the current draft. */
    suspend fun extract(text: String, draft: JsonArray): RambleDraft {
        require(text.isNotBlank() && text.length <= RAMBLE_MAX_TEXT_CHARS) { "text must be 1 to 20000 chars" }
        val res = client.call(
            "POST",
            "/api/v1/ramble/extract",
            buildJsonObject { put("text", text); put("draft", draft) },
        ) as? JsonObject ?: throw ProtocolException("extract answered nothing")
        val raw = (res["draft"] as? JsonArray) ?: throw ProtocolException("extract answered without a draft")
        val tasks = raw.mapNotNull { runCatching { decodeRambleTask(it as JsonObject) }.getOrNull() }
        val ops = ((res["ops"] as? JsonArray).orEmpty()).mapNotNull {
            val o = it as? JsonObject ?: return@mapNotNull null
            val op = o.str("op") ?: return@mapNotNull null
            val ref = o.str("ref") ?: return@mapNotNull null
            RambleOp(op, ref)
        }
        return RambleDraft(raw, tasks, ops)
    }

    /** Commit the reviewed draft (with the review's project overrides applied). */
    suspend fun commit(tasks: JsonArray): List<RambleCreated> {
        require(tasks.size in 1..RAMBLE_MAX_DRAFT) { "commit needs 1 to 50 tasks" }
        val res = client.call(
            "POST",
            "/api/v1/ramble/commit",
            buildJsonObject { put("tasks", tasks) },
        ) as? JsonObject ?: throw ProtocolException("commit answered nothing")
        return ((res["created"] as? JsonArray).orEmpty()).mapNotNull {
            val o = it as? JsonObject ?: return@mapNotNull null
            val ref = o.str("ref") ?: return@mapNotNull null
            val taskId = o.str("taskId") ?: return@mapNotNull null
            RambleCreated(ref, taskId)
        }
    }
}

fun decodeRambleTask(o: JsonObject): RambleDraftTask {
    val labels = (o["labels"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
    return RambleDraftTask(
        ref = o.str("ref") ?: throw ProtocolException("draft task without ref"),
        content = o.str("content") ?: throw ProtocolException("draft task without content"),
        description = o.str("description"),
        duePhrase = o.str("due"),
        priority = (o["priority"] as? JsonPrimitive)?.intOrNull,
        project = o.str("project"),
        section = o.str("section"),
        labels = labels,
        assignee = o.str("assignee"),
        resolution = (o["resolved"] as? JsonObject)?.let(::decodeRambleResolution),
    )
}

private fun decodeRambleResolution(o: JsonObject): RambleResolution {
    val labels = (o["labels"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
    val issues = (o["issues"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
    return RambleResolution(
        projectId = o.str("projectId"),
        sectionId = o.str("sectionId"),
        due = decodeDue(o["due"]),
        labels = labels,
        assigneeId = o.str("assigneeId"),
        issues = issues,
    )
}

/**
 * The review's project choice for one draft task: a chosen project sets the `projectId`
 * override (the server prefers it over the named project); clearing it removes the key so
 * the named project applies again.
 */
fun JsonObject.withProjectId(projectId: String?): JsonObject =
    if (projectId == null) JsonObject(filterKeys { it != "projectId" })
    else JsonObject(this + ("projectId" to JsonPrimitive(projectId)))

/** Commit payload from the reviewed draft with the review's per-task project overrides. */
fun commitTasks(draft: JsonArray, overrides: Map<String, String?>): JsonArray =
    JsonArray(
        draft.mapNotNull {
            val o = it as? JsonObject ?: return@mapNotNull null
            val ref = o.str("ref") ?: return@mapNotNull null
            if (ref in overrides) o.withProjectId(overrides.getValue(ref)) else o
        },
    )
