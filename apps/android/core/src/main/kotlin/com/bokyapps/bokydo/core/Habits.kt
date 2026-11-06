package com.bokyapps.bokydo.core

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters
import java.util.UUID

@Serializable
data class HabitDay(val date: String, val completed: Boolean)

@Serializable
data class HabitProgress(val completed: Int, val target: Int, val start: String, val end: String)

@Serializable
data class HabitStreak(val current: Int, val unit: String)

@Serializable
data class Habit(
    val id: String,
    val name: String,
    val period: String,
    val target: Int,
    val todayCompleted: Boolean,
    val progress: HabitProgress,
    val history: List<HabitDay>,
    val streak: HabitStreak = HabitStreak(0, "day"),
)

@Serializable
data class HabitsResponse(val today: String, val habits: List<Habit>)

/** Desired state for a specific day, never a toggle: replaying a PUT is idempotent. */
@Serializable
data class HabitCheckIn(val uuid: String, val habitId: String, val date: String, val completed: Boolean)

data class HabitRow(val id: String, val name: String, val completed: Boolean, val progress: Int, val target: Int, val period: String, val pending: Boolean)

/** Account-bound operations must ignore an owner that no longer matches the local account. */
interface HabitStore {
    fun cachedHabits(owner: String): HabitsResponse?
    fun saveHabits(owner: String, response: HabitsResponse)
    fun pendingHabits(owner: String): List<HabitCheckIn>
    fun enqueueHabit(owner: String, change: HabitCheckIn)
    fun acknowledgeHabit(owner: String, uuid: String)
    fun habitError(owner: String): String?
    fun setHabitError(owner: String, message: String?)
}

/** REST habits have their own durable cache/queue, independent of the task sync protocol. */
class HabitSync(
    private val store: HabitStore,
    private val owner: () -> String?,
    private val call: suspend (String, String, JsonObject?) -> kotlinx.serialization.json.JsonElement?,
) {
    private val mutex = Mutex()

    fun checkIn(account: String, habitId: String, date: String, completed: Boolean) {
        if (owner() != account) return
        require(UUID.fromString(habitId).toString() == habitId.lowercase())
        LocalDate.parse(date)
        if (store.cachedHabits(account)?.habits?.none { it.id == habitId } != false) return
        store.enqueueHabit(account, HabitCheckIn(UUID.randomUUID().toString(), habitId, date, completed))
        store.setHabitError(account, null)
    }

    suspend fun sync() = mutex.withLock {
        val account = owner() ?: return@withLock
        val confirmed = mutableListOf<String>()
        for (change in store.pendingHabits(account)) {
            if (owner() != account) return@withLock
            try {
                call("PUT", "/api/v1/habits/${change.habitId}/check-ins/${change.date}", buildJsonObject { put("completed", change.completed) })
                confirmed += change.uuid
            } catch (error: ServerException) {
                // Refused/deleted habits cannot succeed on retry. Keep transport/server failures queued.
                if (error.status !in listOf(400, 403, 404, 409, 422)) throw error
                store.setHabitError(account, "A habit check-in could not be saved. Review the current habit and try again.")
                store.acknowledgeHabit(account, change.uuid)
            }
            if (owner() != account) return@withLock
        }
        if (owner() != account) return@withLock
        val response = call("GET", "/api/v1/habits", null) ?: throw ProtocolException("Missing habits")
        val decoded = Json.decodeFromJsonElement(HabitsResponse.serializer(), response)
        if (owner() == account) {
            // Retain desired states until their confirmed snapshot is durable, even when GET fails.
            store.saveHabits(account, decoded)
            for (uuid in confirmed) store.acknowledgeHabit(account, uuid)
        }
    }
}

/** Compute today's checkboxes from dated history, so cached 'today' never leaks across midnight. */
fun habitRows(response: HabitsResponse?, pending: List<HabitCheckIn>, today: String, weekStart: String): List<HabitRow> {
    val date = LocalDate.parse(today)
    val first = when (weekStart) {
        "sunday" -> DayOfWeek.SUNDAY
        "saturday" -> DayOfWeek.SATURDAY
        else -> DayOfWeek.MONDAY
    }
    return response?.habits.orEmpty().map { habit ->
        val days = habit.history.filter { it.completed }.map { it.date }.toMutableSet()
        val changes = pending.filter { it.habitId == habit.id }
        for (change in changes) {
            if (change.completed) days.add(change.date) else days.remove(change.date)
        }
        val start = if (habit.period == "day") date else date.with(TemporalAdjusters.previousOrSame(first))
        val end = if (habit.period == "day") date else start.plusDays(6)
        HabitRow(habit.id, habit.name, today in days, days.count { it >= start.toString() && it <= end.toString() && it <= today }, habit.target, habit.period, changes.isNotEmpty())
    }
}
