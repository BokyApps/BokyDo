package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/**
 * What the screens read, decoded from the synced JSON (the store keeps the server's JSON so new
 * fields survive; this is the subset the app shows). Decoding is lenient: a malformed entity is
 * skipped rather than breaking a whole list.
 */
data class Due(
    val date: String,
    val time: String?,
    val timezone: String?,
    val string: String,
    val recurring: Boolean,
)

data class Task(
    val id: String,
    val projectId: String,
    val sectionId: String?,
    val parentId: String?,
    val content: String,
    val description: String,
    val priority: Int,
    val due: Due?,
    val deadline: String?,
    val labels: List<String>,
    val childOrder: String,
    val isCompleted: Boolean,
)

data class Project(
    val id: String,
    val name: String,
    val color: String,
    val parentId: String?,
    val childOrder: String,
    val isInbox: Boolean,
    val isArchived: Boolean,
    val isFavorite: Boolean,
    val role: String,
) {
    /** Roles that may add and change tasks (the server checks again). */
    val writable: Boolean get() = role == "owner" || role == "admin" || role == "editor"
}

data class Section(val id: String, val projectId: String, val name: String, val sectionOrder: String, val isArchived: Boolean)

data class Label(val id: String, val name: String, val color: String, val itemOrder: String)

data class Prefs(val weekStart: String, val timeFormat: String, val dateFormat: String, val smartDates: Boolean)

data class User(val id: String, val username: String, val inboxProjectId: String, val timeZone: String, val prefs: Prefs)

data class Member(val projectId: String, val userId: String)

data class Person(val id: String, val username: String)

/** The synced data as the screens see it, with queued changes already applied ([Optimistic]). */
data class AppState(
    val user: User?,
    val projects: Map<String, Project>,
    val sections: Map<String, Section>,
    val tasks: Map<String, Task>,
    val labels: Map<String, Label>,
    val members: List<Member>,
    val people: Map<String, Person>,
) {
    companion object {
        val EMPTY = AppState(null, emptyMap(), emptyMap(), emptyMap(), emptyMap(), emptyList(), emptyMap())

        /** Build from stored entities (by type) and the `user`/`members`/`collaborators` snapshots. */
        fun decode(entities: Map<String, List<JsonObject>>, snapshots: Map<String, JsonElement>): AppState {
            fun <T> all(type: String, f: (JsonObject) -> T?): List<T> =
                entities[type].orEmpty().mapNotNull { runCatching { f(it) }.getOrNull() }
            return AppState(
                user = (snapshots["user"] as? JsonObject)?.let { runCatching { decodeUser(it) }.getOrNull() },
                projects = all("projects", ::decodeProject).associateBy { it.id },
                sections = all("sections", ::decodeSection).associateBy { it.id },
                tasks = all("tasks", ::decodeTask).associateBy { it.id },
                labels = all("labels", ::decodeLabel).associateBy { it.id },
                members = (snapshots["members"] as? JsonArray).orEmpty().mapNotNull {
                    val o = it as? JsonObject ?: return@mapNotNull null
                    Member(o.str("projectId") ?: return@mapNotNull null, o.str("userId") ?: return@mapNotNull null)
                },
                people = (snapshots["collaborators"] as? JsonArray).orEmpty().mapNotNull {
                    val o = it as? JsonObject ?: return@mapNotNull null
                    Person(o.str("id") ?: return@mapNotNull null, o.str("username") ?: return@mapNotNull null)
                }.associateBy { it.id },
            )
        }
    }
}

internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.need(key: String): String = str(key) ?: throw ProtocolException("missing $key")
private fun JsonObject.bool(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: false

fun decodeDue(e: JsonElement?): Due? {
    val o = e as? JsonObject ?: return null
    return Due(
        date = o.need("date"),
        time = o.str("time"),
        timezone = o.str("timezone"),
        string = o.str("string") ?: "",
        recurring = o["recurrence"].let { it != null && it !is JsonNull },
    )
}

fun decodeTask(o: JsonObject) = Task(
    id = o.need("id"),
    projectId = o.need("projectId"),
    sectionId = o.str("sectionId"),
    parentId = o.str("parentId"),
    content = o.need("content"),
    description = o.str("description") ?: "",
    priority = (o["priority"] as? JsonPrimitive)?.intOrNull?.coerceIn(1, 4) ?: 4,
    due = decodeDue(o["due"]),
    deadline = o.str("deadline"),
    labels = (o["labels"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content },
    childOrder = o.str("childOrder") ?: "",
    isCompleted = o.bool("isCompleted"),
)

fun decodeProject(o: JsonObject) = Project(
    id = o.need("id"),
    name = o.need("name"),
    color = o.str("color") ?: "charcoal",
    parentId = o.str("parentId"),
    childOrder = o.str("childOrder") ?: "",
    isInbox = o.bool("isInbox"),
    isArchived = o.bool("isArchived"),
    isFavorite = o.bool("isFavorite"),
    role = o.str("role") ?: "viewer",
)

fun decodeSection(o: JsonObject) = Section(
    id = o.need("id"),
    projectId = o.need("projectId"),
    name = o.need("name"),
    sectionOrder = o.str("sectionOrder") ?: "",
    isArchived = o.bool("isArchived"),
)

fun decodeLabel(o: JsonObject) = Label(
    id = o.need("id"),
    name = o.need("name"),
    color = o.str("color") ?: "charcoal",
    itemOrder = o.str("itemOrder") ?: "",
)

fun decodeUser(o: JsonObject): User {
    val p = o["preferences"] as? JsonObject ?: JsonObject(emptyMap())
    return User(
        id = o.need("id"),
        username = o.str("username") ?: "",
        inboxProjectId = o.need("inboxProjectId"),
        timeZone = o.str("timeZone") ?: "UTC",
        prefs = Prefs(
            weekStart = p.str("weekStart") ?: "monday",
            timeFormat = p.str("timeFormat") ?: "24h",
            dateFormat = p.str("dateFormat") ?: "dmy",
            smartDates = (p["smartDateRecognition"] as? JsonPrimitive)?.booleanOrNull ?: true,
        ),
    )
}
