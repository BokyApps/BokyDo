package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.util.Locale

/**
 * Home-screen widget logic (A4b): what a widget shows and the colours it uses. Kept pure so it is
 * unit-tested on the JVM; the Glance UI in `:app` only renders what this produces.
 *
 * Theme colours come from the generated [Themes] tokens (A2): a per-widget override chooses
 * system/light/dark, and the family is the user's synced appearance.
 */
object Widgets {
    /** How many rows a widget shows before it stops (a home-screen widget is not a full list). */
    const val MAX_ROWS = 50

    /** One line in a widget. */
    private const val MAX_CONTENT = 200

    /** What list a task widget shows. Filters aren't modelled on Android yet. */
    sealed interface Target {
        data object Inbox : Target
        data object Today : Target
        data object Upcoming : Target
        data class Project(val id: String) : Target
    }

    /** One row of a widget. [tone] is the due-date tone (null when there is no due date). */
    data class Row(
        val id: String,
        val content: String,
        val due: String?,
        val project: String?,
        val priority: Int,
        val completed: Boolean,
        val tone: Dates.Tone?,
    )

    /** A widget's per-instance setting. [alpha] is 0-100 (0 fully transparent). */
    data class Config(val target: Target, val theme: String, val alpha: Int)

    private val DEFAULT = Config(Target.Today, "system", 100)
    private val TARGET_KINDS = setOf("inbox", "today", "upcoming", "project")
    private val THEME_MODES = setOf("system", "light", "dark")

    fun default() = DEFAULT

    /** The stored kind for a target ("inbox", "today", "upcoming", "project"). */
    fun kind(target: Target): String = when (target) {
        Target.Inbox -> "inbox"
        Target.Today -> "today"
        Target.Upcoming -> "upcoming"
        is Target.Project -> "project"
    }

    /** A config as the JSON string the app stores in its private widget settings. */
    fun encode(config: Config): String = buildJsonObject {
        put("target", kind(config.target))
        if (config.target is Target.Project) put("projectId", config.target.id)
        put("theme", config.theme)
        put("alpha", config.alpha)
    }.toString()

    /** Decode, falling back to [default] for anything malformed or incomplete. Never throws. */
    fun decode(json: String?): Config {
        val o = json?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() }
        val target = when ((o?.get("target") as? JsonPrimitive)?.contentOrNull) {
            "inbox" -> Target.Inbox
            "upcoming" -> Target.Upcoming
            "project" ->
                (o["projectId"] as? JsonPrimitive)?.contentOrNull
                    ?.takeIf { it.isNotBlank() }
                    ?.let { Target.Project(it) } ?: Target.Today
            else -> Target.Today
        }
        val theme = (o?.get("theme") as? JsonPrimitive)?.contentOrNull?.takeIf { it in THEME_MODES } ?: "system"
        val alpha = ((o?.get("alpha") as? JsonPrimitive)?.intOrNull ?: 100).coerceIn(0, 100)
        return Config(target, theme, alpha)
    }

    /**
     * The rows a widget shows: open tasks only, bounded, with the web's Today rules (overdue first).
     * [showProject] is true for the aggregate lists, so Inbox and project widgets stay unlabelled.
     */
    fun rows(
        state: AppState,
        target: Target,
        today: String,
        limit: Int = MAX_ROWS,
        locale: Locale = Locale.getDefault(),
    ): List<Row> {
        val prefs = state.user?.prefs ?: Prefs("monday", "24h", "dmy", true)
        val source: List<Pair<Task, Boolean>> = when (target) {
            Target.Today -> {
                val lists = Views.today(state, today)
                lists.overdue.map { it to true } + lists.today.map { it to true }
            }
            Target.Upcoming -> {
                val from = LocalDate.parse(today).plusDays(1).toString()
                val to = LocalDate.parse(today).plusDays(13).toString()
                Views.upcoming(state, from, to).flatMap { (_, tasks) -> tasks.map { it to true } }
            }
            Target.Inbox ->
                state.user?.let { Views.projectTasks(state, it.inboxProjectId) }.orEmpty()
                    .flatMap { (_, tasks) -> tasks.map { it to false } }
            is Target.Project ->
                Views.projectTasks(state, target.id).flatMap { (_, tasks) -> tasks.map { it to false } }
        }
        return source.take(if (limit < 0) MAX_ROWS else limit).map { (task, showProject) ->
            val due = task.due
            Row(
                id = task.id,
                content = task.content.take(MAX_CONTENT),
                due = due?.let { Dates.dueLabel(it, today, prefs) },
                project = if (showProject) {
                    state.projects[task.projectId]?.takeIf { !it.isInbox }?.name
                } else {
                    null
                },
                priority = task.priority,
                completed = task.isCompleted,
                tone = due?.let { Dates.describe(it.date, it.time, today, prefs, locale).tone },
            )
        }
    }

    /**
     * Whether a widget renders dark: an explicit per-widget choice wins, "system" follows the user's
     * synced appearance mode, and that in turn follows the device when it too is "system".
     */
    fun isDark(theme: String, appearanceMode: String, systemDark: Boolean): Boolean = when (theme) {
        "light" -> false
        "dark" -> true
        else -> when (appearanceMode) {
            "light" -> false
            "dark" -> true
            else -> systemDark
        }
    }

    /**
     * The theme tokens a widget draws with: the user's synced theme family, its light or dark
     * variant (following the per-widget override and the device), falling back to BokyDo's own.
     */
    fun tokens(appearance: Appearance, theme: String, systemDark: Boolean): ThemeTokens {
        val dark = isDark(theme, appearance.mode, systemDark)
        val id = if (dark) appearance.darkTheme else appearance.lightTheme
        val def = Themes.byId(id) ?: Themes.byId(if (dark) "bokydo-dark" else "bokydo-light")
        return (def ?: Themes.all.first()).tokens
    }
}
