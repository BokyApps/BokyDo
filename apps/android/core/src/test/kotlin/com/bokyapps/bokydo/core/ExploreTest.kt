package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Comments, labels, filters and search (A2c). */
class ExploreTest {
    private fun obj(json: String) = Json.parseToJsonElement(json) as JsonObject

    private val user = obj(
        """{"id":"u1","username":"bob","inboxProjectId":"inbox","timeZone":"Europe/Lisbon",
           "preferences":{"weekStart":"monday","timeFormat":"24h","dateFormat":"dmy","smartDateRecognition":true}}""",
    )

    private fun project(id: String, name: String) = obj(
        """{"id":"$id","name":"$name","color":"blue","parentId":null,"childOrder":"a$id","isInbox":${id == "inbox"},
           "isArchived":false,"isFavorite":false,"role":"owner"}""",
    )

    private fun task(id: String, content: String = "Task $id", labels: List<String> = emptyList(), done: Boolean = false) = obj(
        """{"id":"$id","projectId":"inbox","sectionId":null,"parentId":null,"content":"$content","description":"",
           "priority":4,"due":null,"deadline":null,"labels":${JsonArray(labels.map { JsonPrimitive(it) })},
           "childOrder":"a$id","isCompleted":$done,"createdAt":"2026-10-01T09:00:00.000Z"}""",
    )

    private fun state(
        tasks: List<JsonObject> = emptyList(),
        labels: List<JsonObject> = emptyList(),
        filters: List<JsonObject> = emptyList(),
        comments: List<JsonObject> = emptyList(),
    ) = AppState.decode(
        mapOf(
            "tasks" to tasks,
            "projects" to listOf(project("inbox", "Inbox"), project("work", "Work")),
            "labels" to labels,
            "filters" to filters,
            "comments" to comments,
        ),
        mapOf("user" to user),
    )

    private fun cmd(type: String, args: String) = Command(type, Ids.newId(), obj(args))

    // ---- comments ----

    @Test
    fun commentsAreDecodedAndListedOldestFirst() {
        val s = state(
            comments = listOf(
                obj("""{"id":"c2","projectId":"inbox","taskId":"t1","userId":"u2","content":"later","createdAt":"2026-10-08T10:00:00.000Z","updatedAt":"2026-10-08T10:00:00.000Z"}"""),
                obj("""{"id":"c1","projectId":"inbox","taskId":"t1","userId":"u1","content":"first","createdAt":"2026-10-07T10:00:00.000Z","updatedAt":"2026-10-07T10:00:00.000Z"}"""),
                obj("""{"id":"c3","projectId":"inbox","taskId":null,"userId":"u1","content":"on the project","createdAt":"2026-10-07T11:00:00.000Z","updatedAt":"2026-10-07T11:00:00.000Z"}"""),
            ),
        )
        assertEquals(listOf("c1", "c2"), Views.commentsOf(s, "t1").map { it.id })
        assertEquals("first", Views.commentsOf(s, "t1").first().content)
    }

    @Test
    fun aQueuedCommentShowsAtOnce() {
        val base = state(listOf(task("t1")))
        val s = Optimistic.apply(
            base,
            listOf(cmd("comment_add", """{"id":"c1","taskId":"t1","content":"on it"}""")),
        )
        val comment = s.comments.getValue("c1")
        assertEquals("on it", comment.content)
        assertEquals("inbox", comment.projectId)
        assertEquals("u1", comment.userId)
        assertTrue("it is waiting for the server", comment.pending)
        assertEquals(listOf("c1"), Views.commentsOf(s, "t1").map { it.id })
    }

    // ---- labels ----

    @Test
    fun labelsAreListedWithTheirTasks() {
        val s = state(
            tasks = listOf(task("1", labels = listOf("Errands")), task("2", labels = listOf("work")), task("3", done = true)),
            labels = listOf(obj("""{"id":"l1","name":"errands","color":"blue","itemOrder":"a1","isFavorite":false}""")),
        )
        assertEquals(listOf("1"), Views.labelTasks(s, "Errands").map { it.id })
        assertEquals(listOf("errands", "work"), Views.allLabelNames(s))
    }

    @Test
    fun renamingALabelFollowsTheTasksAndDeletingTakesItOff() {
        val base = state(
            tasks = listOf(task("1", labels = listOf("old"))),
            labels = listOf(obj("""{"id":"l1","name":"old","color":"blue","itemOrder":"a1","isFavorite":false}""")),
        )
        val renamed = Optimistic.apply(base, listOf(cmd("label_update", """{"id":"l1","name":"new"}""")))
        assertEquals(listOf("new"), renamed.tasks.getValue("1").labels)
        assertEquals("new", renamed.labels.getValue("l1").name)

        val deleted = Optimistic.apply(renamed, listOf(cmd("label_delete", """{"id":"l1"}""")))
        assertTrue(deleted.labels.isEmpty())
        assertEquals(emptyList<String>(), deleted.tasks.getValue("1").labels)
    }

    @Test
    fun aNewLabelShowsAtOnce() {
        val s = Optimistic.apply(state(), listOf(cmd("label_add", """{"id":"l1","name":"errands"}""")))
        assertEquals("errands", s.labels.getValue("l1").name)
        assertTrue(s.labels.getValue("l1").itemOrder.isNotEmpty())
    }

    // ---- filters ----

    @Test
    fun savedFiltersAreDecodedAndChangedAtOnce() {
        val s = state(filters = listOf(obj("""{"id":"f1","name":"Overdue","query":"overdue","color":"red","itemOrder":"a1","isFavorite":false}""")))
        assertEquals("overdue", s.filters.getValue("f1").query)
        val added = Optimistic.apply(s, listOf(cmd("filter_add", """{"id":"f2","name":"Today","query":"today"}""")))
        assertEquals("today", added.filters.getValue("f2").query)
        val updated = Optimistic.apply(added, listOf(cmd("filter_update", """{"id":"f2","query":"today | overdue"}""")))
        assertEquals("today | overdue", updated.filters.getValue("f2").query)
        val deleted = Optimistic.apply(updated, listOf(cmd("filter_delete", """{"id":"f2"}""")))
        assertEquals(setOf("f1"), deleted.filters.keys)
    }

    @Test
    fun theFilterRequestHasWhatTheEngineNeedsAndTheAnswerIsRead() {
        val s = state(
            tasks = listOf(task("1", content = "Buy milk", labels = listOf("shop"))),
            labels = listOf(obj("""{"id":"l1","name":"shop","color":"blue","itemOrder":"a1","isFavorite":false}""")),
        )
        val request = obj(Filters.request(s, "today", "2026-10-07" to "10:00"))
        assertEquals("today", (request["query"] as JsonPrimitive).content)
        assertEquals("2026-10-07", ((request["now"] as JsonObject)["date"] as JsonPrimitive).content)
        assertEquals("u1", (request["userId"] as JsonPrimitive).content)
        val tasks = (request["tasks"] as JsonArray).map { it as JsonObject }
        assertEquals(listOf("1"), tasks.map { (it["id"] as JsonPrimitive).content })
        assertEquals("Buy milk", (tasks[0]["content"] as JsonPrimitive).content)
        assertEquals(listOf("shop"), (tasks[0]["labels"] as JsonArray).map { (it as JsonPrimitive).content })
        assertEquals(
            listOf("Inbox", "Work"),
            (request["projects"] as JsonArray).map { ((it as JsonObject)["name"] as JsonPrimitive).content },
        )

        val ok = Filters.result(
            """{"ok":true,"lists":[{"query":"today","taskIds":["1","gone"]}],"warnings":["No project named “X”"]}""",
            s,
        )
        ok as Filters.Result.Ok
        assertEquals(1, ok.lists.size)
        assertEquals(listOf("1"), ok.lists[0].tasks.map { it.id })
        assertEquals(listOf("No project named “X”"), ok.warnings)

        val bad = Filters.result("""{"ok":false,"error":"Unknown filter term"}""", s)
        assertEquals("Unknown filter term", (bad as Filters.Result.Error).message)
    }

    // ---- search ----

    @Test
    fun searchFindsTasksAndProjects() {
        val s = state(
            tasks = listOf(task("1", content = "Buy milk"), task("2", content = "Other", done = true)),
        )
        val found = Views.search(s, "milk")
        assertEquals(listOf("1"), found.tasks.map { it.id })
        assertEquals(emptyList<String>(), found.projects.map { it.id })
        assertEquals(listOf("Work"), Views.search(s, "wor").projects.map { it.name })
        assertTrue(Views.search(s, "  ").tasks.isEmpty())
    }
}
