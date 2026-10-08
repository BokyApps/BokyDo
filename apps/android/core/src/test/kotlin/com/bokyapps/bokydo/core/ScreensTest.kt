package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class ScreensTest {
    private fun obj(json: String) = Json.parseToJsonElement(json) as JsonObject

    private val user = obj(
        """{"id":"u1","username":"bob","isAdmin":false,"inboxProjectId":"inbox","timeZone":"Europe/Lisbon",
           "preferences":{"weekStart":"monday","timeFormat":"24h","dateFormat":"dmy","smartDateRecognition":true}}""",
    )

    private fun project(id: String, name: String) = obj(
        """{"id":"$id","name":"$name","color":"blue","parentId":null,"childOrder":"a$id","isInbox":${id == "inbox"},
           "isArchived":false,"isFavorite":false,"role":"owner"}""",
    )

    private fun task(id: String, project: String = "inbox", due: String? = null) = obj(
        """{"id":"$id","projectId":"$project","sectionId":null,"parentId":null,"content":"Task $id","description":"",
           "priority":4,"due":${due?.let { """{"date":"$it","time":null,"timezone":null,"string":"$it","recurrence":null}""" } ?: "null"},
           "deadline":null,"labels":[],"childOrder":"a$id","isCompleted":false}""",
    )

    private fun state(
        tasks: List<JsonObject>,
        projects: List<JsonObject> = listOf(project("inbox", "Inbox"), project("work", "Work")),
        sections: List<JsonObject> = emptyList(),
        snapshots: Map<String, JsonElement> = emptyMap(),
    ) = AppState.decode(
        mapOf("tasks" to tasks, "projects" to projects, "sections" to sections),
        mapOf("user" to user) + snapshots,
    )

    private fun cmd(type: String, args: String) = Command(type, Ids.newId(), obj(args))

    // ---- decoding ----

    @Test
    fun decodesTheSyncedShapesAndSkipsBrokenEntities() {
        val s = state(listOf(task("1", due = "2026-10-07"), obj("""{"id":"broken"}""")))
        assertEquals(setOf("1"), s.tasks.keys)
        assertEquals("2026-10-07", s.tasks.getValue("1").due?.date)
        assertEquals("Europe/Lisbon", s.user?.timeZone)
        assertEquals("inbox", s.user?.inboxProjectId)
    }

    // ---- views ----

    @Test
    fun todayIsOverduePlusTodayAndHidesArchivedProjectsAndCompletedTasks() {
        val s = state(
            listOf(
                task("late", due = "2026-10-05"),
                task("now", due = "2026-10-07"),
                task("later", due = "2026-10-09"),
                JsonObject(task("done", due = "2026-10-07") + ("isCompleted" to JsonPrimitive(true))),
                task("archived", project = "old", due = "2026-10-07"),
                task("nodate"),
            ),
            projects = listOf(project("inbox", "Inbox"), JsonObject(project("old", "Old") + ("isArchived" to JsonPrimitive(true)))),
        )
        val today = Views.today(s, "2026-10-07")
        assertEquals(listOf("late"), today.overdue.map { it.id })
        assertEquals(listOf("now"), today.today.map { it.id })
        assertEquals(listOf("2026-10-09"), Views.upcoming(s, "2026-10-08", "2026-10-20").map { it.first })
    }

    @Test
    fun projectTasksGroupBySectionInOrderWithOrphansUnsectioned() {
        val sec = obj("""{"id":"s1","projectId":"work","name":"Next","sectionOrder":"a1","isArchived":false}""")
        val s = state(
            listOf(
                task("b", project = "work"),
                task("a", project = "work"),
                task("c", project = "work").let { JsonObject(it + ("sectionId" to JsonPrimitive("s1"))) },
                task("lost", project = "work").let { JsonObject(it + ("sectionId" to JsonPrimitive("gone"))) },
                task("child", project = "work").let { JsonObject(it + ("parentId" to JsonPrimitive("a"))) },
            ),
            sections = listOf(sec),
        )
        val groups = Views.projectTasks(s, "work")
        assertEquals(listOf(null, "s1"), groups.map { it.first?.id })
        assertEquals(listOf("a", "b", "lost"), groups[0].second.map { it.id })
        assertEquals(listOf("c"), groups[1].second.map { it.id })
        assertEquals(listOf("child"), Views.children(s, "a").map { it.id })
    }

    // ---- optimistic changes ----

    @Test
    fun queuedAddsCompletesAndDeletesShowAtOnce() {
        val base = state(listOf(task("1"), task("2").let { JsonObject(it + ("parentId" to JsonPrimitive("1"))) }))
        val s = Optimistic.apply(
            base,
            listOf(
                cmd("task_add", """{"id":"new","content":"Buy milk","priority":1,"labels":["shop"]}"""),
                cmd("task_complete", """{"id":"1"}"""),
            ),
        )
        val added = s.tasks.getValue("new")
        assertEquals("inbox", added.projectId)
        assertEquals(1, added.priority)
        assertEquals(listOf("shop"), added.labels)
        assertTrue("sub-tasks complete with their parent", s.tasks.getValue("2").isCompleted)
        assertEquals(listOf("1", "new"), Views.projectTasks(Optimistic.apply(base, listOf(cmd("task_add", """{"id":"new","content":"x"}"""))), "inbox")[0].second.map { it.id })

        val reopened = Optimistic.apply(s, listOf(cmd("task_uncomplete", """{"id":"2"}""")))
        assertFalse("reopening a sub-task reopens its parent", reopened.tasks.getValue("1").isCompleted)

        val deleted = Optimistic.apply(base, listOf(cmd("task_delete", """{"id":"1"}""")))
        assertTrue(deleted.tasks.isEmpty())
    }

    @Test
    fun recurringCompletionWaitsForTheServerAndUnknownTargetsAreIgnored() {
        val recurring = task("r", due = "2026-10-07").let {
            val due = (it["due"] as JsonObject) + ("recurrence" to obj("""{"rrule":"FREQ=DAILY","anchor":"scheduled"}"""))
            JsonObject(it + ("due" to JsonObject(due)))
        }
        val base = state(listOf(recurring))
        val s = Optimistic.apply(
            base,
            listOf(
                cmd("task_complete", """{"id":"r"}"""),
                cmd("task_complete", """{"id":"missing"}"""),
                cmd("task_update", """{"id":"missing","content":"x"}"""),
                cmd("project_add", """{"id":"p","name":"P"}"""),
                cmd("task_add", """{"id":"bad"}"""),
            ),
        )
        assertEquals(base, s)
    }

    @Test
    fun updatesAndMovesApplyLikeTheWeb() {
        val base = state(listOf(task("1", due = "2026-10-07"), task("k").let { JsonObject(it + ("parentId" to JsonPrimitive("1"))) }))
        val s = Optimistic.apply(
            base,
            listOf(
                cmd("task_update", """{"id":"1","content":"Renamed","due":null}"""),
                cmd("task_move", """{"id":"1","projectId":"work"}"""),
            ),
        )
        val t = s.tasks.getValue("1")
        assertEquals("Renamed", t.content)
        assertNull(t.due)
        assertEquals("work", t.projectId)
        assertEquals("sub-tasks move with their parent", "work", s.tasks.getValue("k").projectId)
    }

    // ---- dates ----

    @Test
    fun dateLabelsMatchTheWeb() {
        val prefs = Prefs("monday", "24h", "dmy", true)
        val en = Locale.ENGLISH
        assertEquals("Today", Dates.describe("2026-10-07", null, "2026-10-07", prefs, en).label)
        assertEquals("Tomorrow 14:00", Dates.describe("2026-10-08", "14:00", "2026-10-07", prefs, en).label)
        assertEquals("Friday", Dates.describe("2026-10-09", null, "2026-10-07", prefs, en).label)
        assertEquals(Dates.Tone.OVERDUE, Dates.describe("2026-10-01", null, "2026-10-07", prefs, en).tone)
        assertEquals("20 Oct", Dates.describe("2026-10-20", null, "2026-10-07", prefs, en).label)
        assertEquals("3 Jan 2027", Dates.describe("2027-01-03", null, "2026-10-07", prefs, en).label)
        val us = Prefs("sunday", "12h", "mdy", true)
        assertEquals("Oct 20 3pm", Dates.makeDueString("2026-10-20", "15:00", "2026-10-07", us, en))
        assertEquals("Oct 20 9:30am", Dates.makeDueString("2026-10-20", "09:30", "2026-10-07", us, en))
        assertEquals("12am", Dates.formatTime("00:00", us))
    }

    // ---- quick add ----

    /** The parser's real output for this input (packages/nlp, run in Node). */
    private val parsedJson = """{"content":"Call Ana","tokens":[{"kind":"due","start":9,"end":21,"text":"tomorrow 3pm"},
        {"kind":"project","start":22,"end":27,"text":"#Work"},{"kind":"priority","start":28,"end":30,"text":"p1"},
        {"kind":"label","start":31,"end":37,"text":"@phone"},{"kind":"reminder","start":38,"end":42,"text":"!30m"}],
        "due":{"date":"2026-10-08","time":"15:00","timezone":null,"string":"tomorrow 3pm","recurrence":null},
        "deadline":null,"priority":1,"labels":["phone"],"projectId":"work","sectionId":null,"assigneeId":null,
        "durationMinutes":null,"reminders":[{"type":"relative","minutesBefore":30}]}"""
    private val typed = "Call Ana tomorrow 3pm #Work p1 @phone !30m"

    @Test
    fun parserInputHasWritableProjectsPathsLabelsAndNowAsJson() {
        val sub = JsonObject(project("sub", "Sub") + ("parentId" to JsonPrimitive("work")))
        val viewer = JsonObject(project("ro", "ReadOnly") + ("role" to JsonPrimitive("viewer")))
        val s = state(
            listOf(JsonObject(task("1") + ("labels" to JsonArray(listOf(JsonPrimitive("Phone")))))),
            projects = listOf(project("inbox", "Inbox"), project("work", "Work"), sub, viewer),
        )
        val input = Json.parseToJsonElement(
            QuickAdd.input("say \"hi\"); x(", s, "work", "2026-10-07" to "10:00", setOf("label:@phone")),
        ) as JsonObject
        assertEquals("text travels as data", "say \"hi\"); x(", (input["text"] as JsonPrimitive).content)
        val o = input["options"] as JsonObject
        val names = (o["projects"] as JsonArray).map { ((it as JsonObject)["name"] as JsonPrimitive).content }
        assertEquals(listOf("Inbox", "Work", "Sub", "Work/Sub"), names)
        assertEquals(listOf("Phone"), (o["labels"] as JsonArray).map { (it as JsonPrimitive).content })
        assertEquals(listOf("label:@phone"), (o["disabled"] as JsonArray).map { (it as JsonPrimitive).content })
        assertEquals("work", (o["defaultProjectId"] as JsonPrimitive).content)
        assertEquals("dmy", (o["dateOrder"] as JsonPrimitive).content)
    }

    @Test
    fun parsedResultBecomesTheWebsCommands() {
        val p = QuickAdd.parseResult(parsedJson, typed)
        assertEquals(5, p.tokens.size)
        var n = 0
        val commands = QuickAdd.commands(typed, p, "inbox", null, "2026-10-07", Prefs("monday", "24h", "dmy", true)) { "id${n++}" }
        assertEquals(listOf("task_add", "reminder_add"), commands.map { it.first })
        val add = commands[0].second
        assertEquals("Call Ana", (add["content"] as JsonPrimitive).content)
        assertEquals("work", (add["projectId"] as JsonPrimitive).content)
        assertEquals(JsonNull, add["sectionId"])
        assertEquals(1, (add["priority"] as JsonPrimitive).content.toInt())
        val due = add["due"] as JsonObject
        assertEquals("one-off dates are stored absolute", "8 Oct 15:00".lowercase(), (due["string"] as JsonPrimitive).content.lowercase())
        val rem = commands[1].second
        assertEquals("id0", (rem["taskId"] as JsonPrimitive).content)
        assertEquals(30, (rem["minutesBefore"] as JsonPrimitive).content.toInt())
    }

    @Test
    fun badParserOutputFallsBackToPlainTextAndTokensMustFitTheText() {
        assertEquals("plain text", QuickAdd.parseResult("not json", " plain text ").content)
        val outOfRange = QuickAdd.parseResult(
            """{"content":"x","tokens":[{"kind":"due","start":0,"end":99,"text":"x"}],"labels":[],"reminders":[]}""",
            "x",
        )
        assertTrue(outOfRange.tokens.isEmpty())
        // Only tokens: the typed text becomes the name; nothing at all adds nothing.
        val onlyTokens = QuickAdd.Parsed.plain("").copy(content = "")
        val prefs = Prefs("monday", "24h", "dmy", true)
        assertEquals(
            "tomorrow",
            (QuickAdd.commands("tomorrow", onlyTokens, "inbox", null, "2026-10-07", prefs)[0].second["content"] as JsonPrimitive).content,
        )
        assertTrue(QuickAdd.commands("   ", onlyTokens, "inbox", null, "2026-10-07", prefs).isEmpty())
    }

    @Test
    fun recurringDuesKeepThePhrase() {
        val due = obj("""{"date":"2026-10-12","time":null,"timezone":null,"string":"every monday","recurrence":{"rrule":"FREQ=WEEKLY;BYDAY=MO","anchor":"scheduled"}}""")
        assertEquals(due, QuickAdd.taskDue(due, "2026-10-07", Prefs("monday", "24h", "dmy", true)))
    }

    @Test
    fun localNowUsesTheSyncedZone() {
        // 2026-10-07T23:30Z is already the 8th in Lisbon (UTC+1 in summer time).
        val ms = java.time.Instant.parse("2026-10-07T23:30:00Z").toEpochMilli()
        assertEquals("2026-10-08" to "00:30", QuickAdd.localNow("Europe/Lisbon", ms))
        assertEquals("2026-10-07" to "23:30", QuickAdd.localNow("Not/AZone", ms))
    }
}
