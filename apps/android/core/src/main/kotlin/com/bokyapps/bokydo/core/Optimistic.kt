package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * Queued changes shown before the server has confirmed them, like the web app's reducers
 * (`packages/sync-client/src/reducers.ts`) for the commands this app sends. Only close enough for
 * instant feedback: the server stays authoritative, the next sync replaces the guess, and a
 * command whose target isn't here is a no-op (the server will reject it).
 */
object Optimistic {
    /** New tasks sort after their siblings until the server assigns the real order key. */
    private const val LAST = "￿"

    fun apply(state: AppState, pending: List<Command>): AppState =
        pending.fold(state) { s, c -> runCatching { applyOne(s, c) }.getOrDefault(s) }

    private fun applyOne(s: AppState, c: Command): AppState {
        val a = c.args
        if (c.type == "user_update_preferences") return applyPreferences(s, a)
        val id = a.str("id") ?: return s
        val tasks = s.tasks.toMutableMap()
        when (c.type) {
            "task_add" -> {
                val user = s.user ?: return s
                val parent = a.str("parentId")?.let { tasks[it] }
                val projectId = parent?.projectId ?: a.str("projectId") ?: user.inboxProjectId
                tasks[id] = Task(
                    id = id,
                    projectId = projectId,
                    sectionId = if (parent != null) parent.sectionId else a.str("sectionId"),
                    parentId = parent?.id,
                    content = a.str("content") ?: return s,
                    description = a.str("description") ?: "",
                    priority = (a["priority"] as? JsonPrimitive)?.intOrNull ?: 4,
                    due = decodeDue(a["due"]),
                    deadline = a.str("deadline"),
                    labels = labelsOf(a) ?: emptyList(),
                    childOrder = LAST + id,
                    isCompleted = false,
                )
            }
            "task_update" -> {
                val t = tasks[id] ?: return s
                tasks[id] = t.copy(
                    content = a.str("content") ?: t.content,
                    description = a.str("description") ?: t.description,
                    priority = (a["priority"] as? JsonPrimitive)?.intOrNull ?: t.priority,
                    due = if ("due" in a) decodeDue(a["due"]) else t.due,
                    deadline = if ("deadline" in a) a.str("deadline") else t.deadline,
                    labels = labelsOf(a) ?: t.labels,
                )
            }
            "task_move" -> {
                val t = tasks[id] ?: return s
                val parent = a.str("parentId")?.let { tasks[it] }
                val moved = if (parent != null) {
                    t.copy(projectId = parent.projectId, sectionId = parent.sectionId, parentId = parent.id)
                } else {
                    val projectId = a.str("projectId")
                    val sectionGiven = "sectionId" in a
                    t.copy(
                        projectId = projectId ?: t.projectId,
                        sectionId = when {
                            sectionGiven -> a.str("sectionId")
                            projectId != null && projectId != t.projectId -> null
                            else -> t.sectionId
                        },
                        parentId = if (a["parentId"] is JsonNull || projectId != null || sectionGiven) null else t.parentId,
                    )
                }.let { m -> a.str("childOrder")?.let { m.copy(childOrder = it) } ?: m }
                tasks[id] = moved
                for (child in descendants(tasks, id)) {
                    tasks[child] = tasks.getValue(child).copy(projectId = moved.projectId, sectionId = moved.sectionId)
                }
            }
            "task_complete" -> {
                val t = tasks[id] ?: return s
                // A recurring task moves to its next date on the server; until then it stays put.
                if (t.due?.recurring == true) return s
                for (x in listOf(id) + descendants(tasks, id)) tasks[x] = tasks.getValue(x).copy(isCompleted = true)
            }
            "task_uncomplete" -> {
                var t = tasks[id]
                while (t != null) {
                    tasks[t.id] = t.copy(isCompleted = false)
                    t = t.parentId?.let { tasks[it] }
                }
            }
            "task_delete" -> (listOf(id) + descendants(tasks, id)).forEach { tasks.remove(it) }
            else -> return s
        }
        return s.copy(tasks = tasks)
    }

    private fun labelsOf(a: JsonObject): List<String>? =
        (a["labels"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }

    /**
     * The user's own settings: the appearance (theme, font, text size, density) and the time
     * zone. Shown at once, like the web's reducer does, while the change is still queued.
     */
    private fun applyPreferences(s: AppState, args: JsonObject): AppState {
        val user = s.user ?: return s
        val patch = args["appearance"] as? JsonObject
        val appearance = if (patch != null) Appearance.merge(user.prefs.appearance, patch) else user.prefs.appearance
        val timezone = if ("timezone" in args) args.str("timezone") else user.prefs.timezone
        return s.copy(user = user.copy(prefs = user.prefs.copy(timezone = timezone, appearance = appearance)))
    }

    private fun descendants(tasks: Map<String, Task>, id: String): List<String> {
        val out = mutableListOf<String>()
        val queue = ArrayDeque(listOf(id))
        while (queue.isNotEmpty()) {
            val next = queue.removeFirst()
            for (t in tasks.values) if (t.parentId == next && t.id !in out) {
                out += t.id
                queue += t.id
            }
        }
        return out
    }
}
