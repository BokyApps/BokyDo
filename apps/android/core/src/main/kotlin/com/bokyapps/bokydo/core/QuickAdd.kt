package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Quick add, as in the web's TaskEditor (ADR 0016): the text is parsed by `packages/nlp` running
 * in the JavaScript sandbox; this side builds the parser's input from the synced data and turns
 * its result into the same commands the web app sends. The parser's ids are only suggestions:
 * the server checks every one.
 */
object QuickAdd {
    data class Highlight(val kind: String, val start: Int, val end: Int, val text: String)

    data class Parsed(
        val content: String,
        val tokens: List<Highlight>,
        val due: JsonObject?,
        val deadline: String?,
        val priority: Int?,
        val labels: List<String>,
        val projectId: String?,
        val sectionId: String?,
        val assigneeId: String?,
        val durationMinutes: Int?,
        val reminders: List<JsonObject>,
    ) {
        companion object {
            /** Nothing recognised: the plain-text fallback when the sandbox isn't available. */
            fun plain(text: String) = Parsed(text.trim(), emptyList(), null, null, null, emptyList(), null, null, null, null, emptyList())
        }
    }

    /** The user's wall-clock date and time in their synced zone ("now" for the parser). */
    fun localNow(timeZone: String, nowMs: Long = System.currentTimeMillis()): Pair<String, String> {
        val zone = runCatching { ZoneId.of(timeZone) }.getOrDefault(ZoneId.of("UTC"))
        val t = ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(nowMs), zone)
        return t.toLocalDate().toString() to "%02d:%02d".format(t.hour, t.minute)
    }

    /**
     * The parser's input: `{ text, options }`, options as `QuickAddOptions` with `disabled` as an
     * array. Like the web, only writable live projects (and their "Parent/Child" paths) are
     * candidates for `#project`, their sections for `/section`, their members for `+name`.
     */
    fun input(text: String, s: AppState, defaultProjectId: String?, now: Pair<String, String>, disabled: Set<String> = emptySet()): String {
        val user = s.user
        val prefs = user?.prefs ?: Prefs("monday", "24h", "dmy", true)
        val projects = mutableListOf<Pair<String, String>>()
        user?.let { u -> s.projects[u.inboxProjectId]?.let { projects += it.id to it.name } }
        fun path(p: Project): String = p.parentId?.let { s.projects[it] }?.let { "${path(it)}/${p.name}" } ?: p.name
        for ((p, _) in Views.projectTree(s)) {
            if (!p.writable) continue
            projects += p.id to p.name
            val full = path(p)
            if (full != p.name) projects += p.id to full
        }
        val ids = projects.map { it.first }.toSet()
        val labelNames = linkedMapOf<String, String>()
        for (l in s.labels.values) labelNames[l.name.lowercase()] = l.name
        for (t in s.tasks.values) for (l in t.labels) labelNames.putIfAbsent(l.lowercase(), l)
        return buildJsonObject {
            put("text", text)
            put("options", buildJsonObject {
                put("now", buildJsonObject {
                    put("date", now.first)
                    put("time", now.second)
                })
                put("weekStart", prefs.weekStart)
                put("dateOrder", prefs.dateFormat)
                put("smartDates", prefs.smartDates)
                put("reminders", true)
                putJsonArray("projects") {
                    for ((id, name) in projects) add(buildJsonObject { put("id", id); put("name", name) })
                }
                putJsonArray("sections") {
                    for (sec in s.sections.values) if (!sec.isArchived && sec.projectId in ids) {
                        add(buildJsonObject { put("id", sec.id); put("name", sec.name); put("projectId", sec.projectId) })
                    }
                }
                putJsonArray("labels") { labelNames.values.sorted().forEach { add(JsonPrimitive(it)) } }
                putJsonArray("members") {
                    for (m in s.members) if (m.projectId in ids) {
                        val person = s.people[m.userId] ?: continue
                        add(buildJsonObject { put("id", person.id); put("name", person.username); put("projectId", m.projectId) })
                    }
                }
                put("defaultProjectId", defaultProjectId ?: user?.inboxProjectId)
                putJsonArray("disabled") { disabled.forEach { add(JsonPrimitive(it)) } }
            })
        }.toString()
    }

    /** The parser's `QuickAddResult` JSON. Anything malformed falls back to plain text. */
    fun parseResult(json: String, text: String): Parsed = runCatching {
        val o = Json.parseToJsonElement(json) as JsonObject
        fun int(k: String) = (o[k] as? JsonPrimitive)?.intOrNull
        Parsed(
            content = o.str("content") ?: "",
            tokens = (o["tokens"] as? JsonArray).orEmpty().mapNotNull {
                val t = it as? JsonObject ?: return@mapNotNull null
                val start = (t["start"] as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null
                val end = (t["end"] as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null
                if (start < 0 || end > text.length || start >= end) return@mapNotNull null
                Highlight(t.str("kind") ?: return@mapNotNull null, start, end, t.str("text") ?: "")
            },
            due = o["due"] as? JsonObject,
            deadline = o.str("deadline"),
            priority = int("priority"),
            labels = (o["labels"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content },
            projectId = o.str("projectId"),
            sectionId = o.str("sectionId"),
            assigneeId = o.str("assigneeId"),
            durationMinutes = int("durationMinutes"),
            reminders = (o["reminders"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject },
        )
    }.getOrElse { Parsed.plain(text) }

    /** The token's key for "keep this as plain text" (`tokenKey` in the parser). */
    fun tokenKey(h: Highlight) = "${h.kind}:${h.text.lowercase()}"

    /**
     * The commands for one task, as the web's TaskEditor sends them: `task_add` (parsed values
     * win over the defaults) and one `reminder_add` per reminder. A line that was nothing but
     * tokens keeps its text as the name.
     */
    fun commands(
        text: String,
        p: Parsed,
        defaultProjectId: String,
        defaultSectionId: String?,
        today: String,
        prefs: Prefs,
        /** Extra detail beyond the title: a share's remaining lines, prefilled for the user. */
        description: String = "",
        newId: () -> String = { Ids.newId() },
    ): List<Pair<String, JsonObject>> {
        val taskId = newId()
        val content = p.content.ifBlank { text.trim() }.take(1000)
        if (content.isEmpty()) return emptyList()
        val add = buildJsonObject {
            put("id", taskId)
            put("content", content)
            put("projectId", p.projectId ?: defaultProjectId)
            // A parsed #project takes its own /section or none; otherwise the screen's section.
            val sectionId = if (p.projectId != null) p.sectionId else p.sectionId ?: defaultSectionId
            put("sectionId", sectionId?.let(::JsonPrimitive) ?: JsonNull)
            put("priority", p.priority ?: 4)
            if (description.isNotBlank()) put("description", description.take(16000))
            put("due", p.due?.let { taskDue(it, today, prefs) } ?: JsonNull)
            putJsonArray("labels") { p.labels.forEach { add(JsonPrimitive(it)) } }
            p.deadline?.let { put("deadline", it) }
            p.durationMinutes?.let { put("durationMinutes", it) }
            p.assigneeId?.let { put("assigneeId", it) }
        }
        val reminders = p.reminders.mapNotNull { r ->
            val args = when (r.str("type")) {
                "relative" -> buildJsonObject {
                    put("id", newId())
                    put("taskId", taskId)
                    put("type", "relative")
                    put("minutesBefore", (r["minutesBefore"] as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null)
                }
                "absolute" -> buildJsonObject {
                    put("id", newId())
                    put("taskId", taskId)
                    put("type", "absolute")
                    put("date", r.str("date") ?: return@mapNotNull null)
                    put("time", r.str("time") ?: return@mapNotNull null)
                }
                else -> return@mapNotNull null
            }
            "reminder_add" to args
        }
        return listOf("task_add" to add) + reminders
    }

    /** Recurring dues keep the phrase as typed; one-off dates get the absolute form (`toTaskDue`). */
    fun taskDue(parsed: JsonObject, today: String, prefs: Prefs): JsonElement {
        val recurrence = parsed["recurrence"]
        if (recurrence != null && recurrence !is JsonNull) return parsed
        val date = parsed.str("date") ?: return JsonNull
        val time = parsed.str("time")
        return buildJsonObject {
            put("date", date)
            put("time", time?.let(::JsonPrimitive) ?: JsonNull)
            put("timezone", JsonNull)
            put("string", Dates.makeDueString(date, time, today, prefs))
            put("recurrence", JsonNull)
        }
    }
}
