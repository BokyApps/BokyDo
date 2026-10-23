package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class WidgetTest {
    private fun obj(json: String) = Json.parseToJsonElement(json) as JsonObject

    private val user = obj(
        """{"id":"u1","username":"bob","isAdmin":false,"inboxProjectId":"inbox","timeZone":"Europe/Lisbon",
           "preferences":{"weekStart":"monday","timeFormat":"24h","dateFormat":"dmy","smartDateRecognition":true,
           "appearance":{"mode":"dark","lightTheme":"bokydo-light","darkTheme":"bokydo-dark","font":"system",
           "textSize":"default","density":"comfortable"}}}""",
    )

    private fun project(id: String, name: String) = obj(
        """{"id":"$id","name":"$name","color":"blue","parentId":null,"childOrder":"a$id","isInbox":${id == "inbox"},
           "isArchived":false,"isFavorite":false,"role":"owner"}""",
    )

    private fun task(id: String, project: String = "inbox", due: String? = null, completed: Boolean = false) = obj(
        """{"id":"$id","projectId":"$project","sectionId":null,"parentId":null,"content":"Task $id","description":"",
           "priority":4,"due":${due?.let { """{"date":"$it","time":null,"timezone":null,"string":"$it","recurrence":null}""" } ?: "null"},
           "deadline":null,"labels":[],"childOrder":"a$id","isCompleted":$completed}""",
    )

    private fun state(
        tasks: List<JsonObject>,
        projects: List<JsonObject> = listOf(project("inbox", "Inbox"), project("work", "Work")),
        snapshots: Map<String, JsonElement> = emptyMap(),
    ) = AppState.decode(
        mapOf("tasks" to tasks, "projects" to projects),
        mapOf("user" to user) + snapshots,
    )

    // ---- config ----

    @Test
    fun configRoundTripsAndInjectsTheProjectId() {
        val project = Widgets.Config(Widgets.Target.Project("work"), "dark", 80)
        val decoded = Widgets.decode(Widgets.encode(project))
        assertEquals(project, decoded)
        assertEquals("work", ((decoded.target) as Widgets.Target.Project).id)
    }

    @Test
    fun malformedConfigFallsBackToTheDefaultAndClampsAlpha() {
        assertEquals(Widgets.default(), Widgets.decode(null))
        assertEquals(Widgets.default(), Widgets.decode("not json"))
        assertEquals(Widgets.default(), Widgets.decode("""{"target":"project"}"""))
        assertEquals(Widgets.default(), Widgets.decode("""{"target":"nope"}"""))
        // Unknown theme and out-of-range alpha are corrected rather than rejected.
        val fixed = Widgets.decode("""{"target":"inbox","theme":"neon","alpha":999}""")
        assertEquals(Widgets.Target.Inbox, fixed.target)
        assertEquals("system", fixed.theme)
        assertEquals(100, fixed.alpha)
        assertEquals(0, Widgets.decode("""{"target":"today","alpha":-4}""").alpha)
    }

    // ---- rows ----

    @Test
    fun todayPutsOverdueFirstAndHidesCompletedAndArchived() {
        val s = state(
            listOf(
                task("late", due = "2026-10-05"),
                task("now", due = "2026-10-07"),
                task("done", due = "2026-10-07", completed = true),
                task("archived", project = "old", due = "2026-10-07"),
                task("later", due = "2026-10-20"),
            ),
            projects = listOf(project("inbox", "Inbox"), JsonObject(project("old", "Old") + ("isArchived" to JsonPrimitive(true)))),
        )
        val rows = Widgets.rows(s, Widgets.Target.Today, "2026-10-07", locale = Locale.ENGLISH)
        assertEquals(listOf("late", "now"), rows.map { it.id })
        assertEquals(Dates.Tone.OVERDUE, rows[0].tone)
        assertEquals("Today", rows[1].due)
        assertEquals("Task now", rows[1].content)
    }

    @Test
    fun projectAndInboxRowsAreNotLabelledWithTheirProject() {
        val s = state(
            listOf(
                task("a", project = "work"),
                task("b", project = "work").let { JsonObject(it + ("isCompleted" to JsonPrimitive(true))) },
                task("c"),
            ),
        )
        val work = Widgets.rows(s, Widgets.Target.Project("work"), "2026-10-07", locale = Locale.ENGLISH)
        assertEquals(listOf("a"), work.map { it.id })
        assertNull("a project widget does not repeat the project on every row", work[0].project)
        assertEquals(listOf("c"), Widgets.rows(s, Widgets.Target.Inbox, "2026-10-07").map { it.id })
    }

    @Test
    fun upcomingSpansTomorrowToTwoWeeksAndLimitsTheRows() {
        val s = state(
            listOf(
                task("today", due = "2026-10-07"),
                task("day1", due = "2026-10-08"),
                task("day14", due = "2026-10-21"),
                task("day15", due = "2026-10-22"),
            ),
        )
        val rows = Widgets.rows(s, Widgets.Target.Upcoming, "2026-10-07", locale = Locale.ENGLISH)
        assertEquals(listOf("day1"), rows.map { it.id })
        assertEquals("Work", Widgets.rows(state(listOf(task("w", project = "work", due = "2026-10-07"))), Widgets.Target.Today, "2026-10-07")[0].project)
        assertEquals(listOf("day1"), Widgets.rows(s, Widgets.Target.Upcoming, "2026-10-07", limit = 1).map { it.id })
    }

    @Test
    fun decodingCarriesTheSyncedAppearance() {
        val appearance = state(emptyList()).user?.prefs?.appearance
        assertEquals("dark", appearance?.mode)
        assertEquals("bokydo-light", appearance?.lightTheme)
        val noAppearance = AppState.decode(
            mapOf("tasks" to emptyList()),
            mapOf("user" to obj("""{"id":"u","username":"x","inboxProjectId":"inbox","timeZone":"UTC","preferences":{}}""")),
        )
        assertEquals(Appearance.DEFAULT, noAppearance.user?.prefs?.appearance)
    }

    // ---- theme ----

    @Test
    fun themeResolutionPrefersTheWidgetOverrideThenTheSyncedAppearanceThenTheSystem() {
        assertTrue(Widgets.isDark("dark", "light", systemDark = false))
        assertFalse(Widgets.isDark("light", "dark", systemDark = true))
        assertTrue(Widgets.isDark("system", "dark", systemDark = false))
        assertFalse(Widgets.isDark("system", "light", systemDark = true))
        assertTrue(Widgets.isDark("system", "system", systemDark = true))
        assertFalse(Widgets.isDark("system", "system", systemDark = false))
    }

    @Test
    fun tokensFollowTheSyncedThemeFamilyAndTheWidgetOverride() {
        val appearance = Appearance.DEFAULT.copy(lightTheme = "gruvbox-light", darkTheme = "gruvbox-dark")
        assertEquals(0xFFFBF1C7, Widgets.tokens(appearance, "light", systemDark = true).bg)
        assertEquals(0xFF282828, Widgets.tokens(appearance, "dark", systemDark = false).bg)
        // "system" follows the user's mode, then the device.
        assertEquals(0xFFFBF1C7, Widgets.tokens(appearance.copy(mode = "light"), "system", systemDark = true).bg)
        assertEquals(0xFF282828, Widgets.tokens(appearance.copy(mode = "dark"), "system", systemDark = false).bg)
        // The four priority colours are all distinct and differ from the muted text colour.
        val c = Widgets.tokens(Appearance.DEFAULT, "system", systemDark = false)
        assertEquals(4, setOf(c.p1, c.p2, c.p3, c.p4).size)
        assertTrue(c.p1 != c.muted)
        // An unknown theme id falls back to BokyDo's own defaults.
        assertEquals(0xFFFAFAFA, Widgets.tokens(appearance.copy(lightTheme = "neon"), "light", false).bg)
    }
}
