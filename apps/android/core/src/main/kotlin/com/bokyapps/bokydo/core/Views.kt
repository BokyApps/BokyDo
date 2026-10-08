package com.bokyapps.bokydo.core

import java.time.LocalDate
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * The lists the screens show, with the web app's rules (`apps/web/src/lib/views.ts`): tasks in
 * archived projects are hidden; Today is overdue plus today, sub-tasks included; projects show
 * top-level tasks by section. Order keys compare as plain strings, as in JavaScript.
 */
object Views {
    private val byOrder = compareBy<Task> { it.childOrder }

    fun liveTasks(s: AppState): List<Task> = s.tasks.values.filter { t ->
        val p = s.projects[t.projectId]
        p != null && !p.isArchived
    }

    data class Today(val overdue: List<Task>, val today: List<Task>)

    fun today(s: AppState, today: String): Today {
        val open = liveTasks(s).filter { !it.isCompleted && it.due != null }
        return Today(
            overdue = sortByDate(open.filter { it.due!!.date < today }),
            today = sortByDate(open.filter { it.due!!.date == today }),
        )
    }

    /** Open tasks due from [from] to [to] (inclusive), grouped by day in date order. */
    fun upcoming(s: AppState, from: String, to: String): List<Pair<String, List<Task>>> =
        liveTasks(s).filter { !it.isCompleted && it.due != null && it.due.date in from..to }
            .groupBy { it.due!!.date }
            .toSortedMap()
            .map { (day, tasks) -> day to sortByDate(tasks) }

    /** Top-level open tasks of a project grouped by its live sections (null: no section), in order. */
    fun projectTasks(s: AppState, projectId: String): List<Pair<Section?, List<Task>>> {
        val sections = sectionsOf(s, projectId)
        val ids = sections.map { it.id }.toSet()
        val tasks = s.tasks.values.filter { it.projectId == projectId && it.parentId == null && !it.isCompleted }
        val groups = tasks.groupBy { if (it.sectionId != null && it.sectionId in ids) it.sectionId else null }
        return listOf<Pair<Section?, List<Task>>>(null to groups[null].orEmpty().sortedWith(byOrder)) +
            sections.map { it to groups[it.id].orEmpty().sortedWith(byOrder) }
    }

    fun sectionsOf(s: AppState, projectId: String): List<Section> =
        s.sections.values.filter { it.projectId == projectId && !it.isArchived }.sortedBy { it.sectionOrder }

    fun children(s: AppState, parentId: String): List<Task> =
        s.tasks.values.filter { it.parentId == parentId }.sortedWith(byOrder)

    /** Non-inbox, non-archived projects as a flattened tree: (project, depth). */
    fun projectTree(s: AppState): List<Pair<Project, Int>> {
        val all = s.projects.values.filter { !it.isInbox && !it.isArchived }.sortedBy { it.childOrder }
        val ids = all.map { it.id }.toSet()
        val out = mutableListOf<Pair<Project, Int>>()
        fun walk(parentId: String?, depth: Int) {
            for (p in all) {
                val isChild = if (parentId == null) p.parentId == null || p.parentId !in ids else p.parentId == parentId
                if (isChild) {
                    out += p to depth
                    walk(p.id, depth + 1)
                }
            }
        }
        walk(null, 0)
        return out
    }

    /** By due date and time (no time last within a day), then priority: the web's "date" sort. */
    fun sortByDate(tasks: List<Task>): List<Task> =
        tasks.sortedWith(compareBy<Task>({ it.due?.let { d -> "${d.date} ${d.time ?: "99:99"}" } ?: "9999" }, { it.priority }))
}

/** Date labels like the web's `describeDate`: "Today", "Tomorrow 14:00", "Friday", "12 Oct". */
object Dates {
    enum class Tone { OVERDUE, TODAY, TOMORROW, WEEK, LATER }

    data class Described(val label: String, val tone: Tone)

    fun describe(ymd: String, time: String?, today: String, prefs: Prefs, locale: Locale = Locale.getDefault()): Described {
        val date = LocalDate.parse(ymd)
        val delta = ChronoUnit.DAYS.between(LocalDate.parse(today), date)
        var tone = if (delta < 0) Tone.OVERDUE else Tone.LATER
        val label = when {
            delta == 0L -> "Today".also { tone = Tone.TODAY }
            delta == 1L -> "Tomorrow".also { tone = Tone.TOMORROW }
            delta == -1L -> "Yesterday"
            delta in 2..6 -> date.dayOfWeek.getDisplayName(TextStyle.FULL, locale).also { tone = Tone.WEEK }
            else -> formatDate(ymd, prefs, ymd.take(4) != today.take(4), locale)
        }
        return Described(if (time != null) "$label ${formatTime(time, prefs)}" else label, tone)
    }

    /** What a due date shows: the phrase for recurring ones ("every mon"), else relative. */
    fun dueLabel(due: Due, today: String, prefs: Prefs): String =
        if (due.recurring) due.string else describe(due.date, due.time, today, prefs).label

    fun formatTime(hhmm: String, prefs: Prefs): String {
        if (prefs.timeFormat == "24h") return hhmm
        val (h, m) = hhmm.split(":").map { it.toInt() }
        val minutes = if (m != 0) ":" + m.toString().padStart(2, '0') else ""
        return "${(h + 11) % 12 + 1}$minutes${if (h < 12) "am" else "pm"}"
    }

    fun formatDate(ymd: String, prefs: Prefs, withYear: Boolean, locale: Locale = Locale.getDefault()): String {
        val d = LocalDate.parse(ymd)
        val month = d.month.getDisplayName(TextStyle.SHORT, locale)
        val year = if (withYear) " ${d.year}" else ""
        return when (prefs.dateFormat) {
            "mdy" -> "$month ${d.dayOfMonth}$year"
            "ymd" -> if (withYear) "${d.year} $month ${d.dayOfMonth}" else "$month ${d.dayOfMonth}"
            else -> "${d.dayOfMonth} $month$year"
        }
    }

    /**
     * A one-off due date as the web's `makeDue` stores it: the phrase is absolute ("6 Oct 17:00"),
     * never relative, because "Tomorrow" would be wrong by the next day.
     */
    fun makeDueString(date: String, time: String?, today: String, prefs: Prefs, locale: Locale = Locale.getDefault()): String {
        val day = formatDate(date, prefs, date.take(4) != today.take(4), locale)
        return if (time != null) "$day ${formatTime(time, prefs)}" else day
    }
}
