package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/**
 * Saved filters, run offline over the synced data. The parser and the evaluator are the web's
 * own (`packages/filter-query`, ADR 0016): this side builds their input and reads their answer,
 * so a filter saved on the web behaves the same on the phone. The engine itself runs in the
 * JavaScript sandbox; if it isn't available the screen says so instead of guessing.
 */
object Filters {
    /** One list of a filter: a comma in the query gives several lists. */
    data class FilterList(val query: String, val tasks: List<Task>)

    sealed interface Result {
        data class Ok(val lists: List<FilterList>, val warnings: List<String>) : Result
        data class Error(val message: String) : Result
    }

    /**
     * The engine's input: the query, the user's local "now" and everything the filter can read
     * (open tasks, projects, sections, people). Same rules as the web's `runFilterLocally`.
     */
    fun request(s: AppState, query: String, now: Pair<String, String>): String {
        val prefs = s.user?.prefs ?: Prefs("monday", "24h", "dmy", true)
        val open = Views.openTasks(s)
        val members = s.members.groupBy { it.projectId }.filterValues { it.size > 1 }.keys
        return buildJsonObject {
            put("query", query)
            put("now", buildJsonObject {
                put("date", now.first)
                put("time", now.second)
            })
            put("weekStart", prefs.weekStart)
            put("dateOrder", prefs.dateFormat)
            put("timeZone", s.user?.timeZone ?: "UTC")
            put("userId", s.user?.id ?: "")
            putJsonArray("tasks") {
                for (t in open) {
                    add(
                        buildJsonObject {
                            put("id", t.id)
                            put("projectId", t.projectId)
                            put("sectionId", t.sectionId?.let(::JsonPrimitive) ?: JsonNull)
                            put("parentId", t.parentId?.let(::JsonPrimitive) ?: JsonNull)
                            put("content", t.content)
                            put("description", t.description)
                            put("priority", t.priority)
                            put(
                                "due",
                                t.due?.let { d ->
                                    buildJsonObject {
                                        put("date", d.date)
                                        put("time", d.time?.let(::JsonPrimitive) ?: JsonNull)
                                        // The evaluator only asks whether there is a recurrence.
                                        put("recurrence", if (d.recurring) buildJsonObject {} else JsonNull)
                                    }
                                } ?: JsonNull,
                            )
                            put("deadline", t.deadline?.let(::JsonPrimitive) ?: JsonNull)
                            putJsonArray("labels") { t.labels.forEach { add(JsonPrimitive(it)) } }
                            put("assigneeId", t.assigneeId?.let(::JsonPrimitive) ?: JsonNull)
                            put("assignedById", t.assignedById?.let(::JsonPrimitive) ?: JsonNull)
                            put("createdAt", t.createdAt ?: "")
                        },
                    )
                }
            }
            putJsonArray("projects") {
                for (p in s.projects.values) {
                    add(
                        buildJsonObject {
                            put("id", p.id)
                            put("name", p.name)
                            put("parentId", p.parentId?.let(::JsonPrimitive) ?: JsonNull)
                        },
                    )
                }
            }
            putJsonArray("sections") {
                for (sec in s.sections.values) {
                    add(
                        buildJsonObject {
                            put("id", sec.id)
                            put("name", sec.name)
                            put("projectId", sec.projectId)
                        },
                    )
                }
            }
            putJsonArray("users") {
                for (person in s.people.values) {
                    add(buildJsonObject { put("id", person.id); put("username", person.username) })
                }
            }
            putJsonArray("sharedProjectIds") { members.forEach { add(JsonPrimitive(it)) } }
        }.toString()
    }

    /** The engine's answer: the tasks of every list, or why the filter doesn't work. */
    fun result(json: String, s: AppState): Result {
        val o = runCatching { Json.parseToJsonElement(json) as? JsonObject }.getOrNull()
            ?: return Result.Error("The filter could not be read.")
        if ((o["ok"] as? JsonPrimitive)?.content != "true") {
            val message = (o["error"] as? JsonPrimitive)?.content ?: "This filter doesn't work."
            return Result.Error(message)
        }
        val lists = (o["lists"] as? JsonArray).orEmpty().mapNotNull { list ->
            val l = list as? JsonObject ?: return@mapNotNull null
            val query = (l["query"] as? JsonPrimitive)?.content ?: ""
            val ids = (l["taskIds"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
            FilterList(query, ids.mapNotNull { s.tasks[it] })
        }
        val warnings = (o["warnings"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
        return Result.Ok(lists, warnings)
    }
}
