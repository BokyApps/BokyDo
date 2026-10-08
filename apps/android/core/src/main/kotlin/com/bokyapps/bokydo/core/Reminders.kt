package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import java.time.DateTimeException
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime

/** A reminder with the moment it goes off. `key` changes when the time does (a moved due date). */
data class ScheduledReminder(
    val reminderId: String,
    val taskId: String,
    val title: String,
    val fireAt: Long,
) {
    val key: String get() = "$reminderId@$fireAt"
}

/**
 * Reminders the device schedules itself, so they work offline and without any push service
 * (PLAN D7). The rules are the server's (`computeFireAt`): absolute reminders are fixed; relative
 * ones follow the task's current due time (in its own zone, or floating in the user's zone) and
 * are inactive while the task has no due time; completed tasks never remind.
 */
object Reminders {
    /** The server sends nothing older than this either (`LATE_LIMIT_MS`). */
    const val LATE_LIMIT_MS = 12 * 3_600_000L

    fun schedule(
        reminders: Collection<JsonObject>,
        tasks: Map<String, JsonObject>,
        userZone: String,
    ): List<ScheduledReminder> =
        reminders.mapNotNull { r ->
            val taskId = r.str("taskId") ?: return@mapNotNull null
            val task = tasks[taskId] ?: return@mapNotNull null
            if ((task["isCompleted"] as? JsonPrimitive)?.booleanOrNull == true) return@mapNotNull null
            val at = fireAt(r, task, userZone) ?: return@mapNotNull null
            ScheduledReminder(r.str("id") ?: return@mapNotNull null, taskId, task.str("content") ?: "", at)
        }.sortedBy { it.fireAt }

    fun fireAt(reminder: JsonObject, task: JsonObject, userZone: String): Long? {
        if (reminder.str("type") == "absolute") {
            val date = reminder.str("date") ?: return null
            val time = reminder.str("time") ?: return null
            return zonedInstant(date, time, reminder.str("timeZone") ?: userZone)
        }
        val minutes = (reminder["minutesBefore"] as? JsonPrimitive)?.intOrNull ?: return null
        val due = task["due"] as? JsonObject ?: return null
        val date = due.str("date") ?: return null
        val time = due.str("time") ?: return null
        val at = zonedInstant(date, time, due.str("timezone") ?: userZone) ?: return null
        return at - minutes * 60_000L
    }

    /**
     * The instant of a wall-clock time in a zone. A time skipped by a DST jump moves forward by
     * the gap and a repeated one takes its first occurrence (java.time's rule, and the server's).
     * Unknown zones count as UTC, as on the server.
     */
    fun zonedInstant(date: String, time: String, zone: String): Long? = try {
        val zoneId = try {
            ZoneId.of(zone)
        } catch (_: DateTimeException) {
            ZoneOffset.UTC
        }
        ZonedDateTime.of(LocalDate.parse(date), LocalTime.parse(time), zoneId).toInstant().toEpochMilli()
    } catch (_: Exception) {
        null
    }

    /** Which of `all` to show at `now`: due, not shown before, not too late. */
    fun due(all: List<ScheduledReminder>, shown: Set<String>, now: Long): List<ScheduledReminder> =
        all.filter { it.fireAt <= now && now - it.fireAt <= LATE_LIMIT_MS && it.key !in shown }

    /** When to wake up next: the earliest reminder still ahead. */
    fun next(all: List<ScheduledReminder>, shown: Set<String>, now: Long): Long? =
        all.firstOrNull { it.fireAt > now && it.key !in shown }?.fireAt
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
