package com.bokyapps.bokydo.core

import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

private const val HABIT = "00000000-0000-4000-8000-000000000001"
private const val DAY = "2026-11-06"

private class HabitMemory : HabitStore {
    var account = "one"
    var cache: HabitsResponse? = habitsFixture()
    val queue = mutableListOf<HabitCheckIn>()
    var error: String? = null
    override fun cachedHabits(owner: String) = cache.takeIf { owner == account }
    override fun saveHabits(owner: String, response: HabitsResponse) { if (owner == account) cache = response }
    override fun pendingHabits(owner: String) = if (owner == account) queue.toList() else emptyList()
    override fun enqueueHabit(owner: String, change: HabitCheckIn) { if (owner == account) queue.add(change) }
    override fun acknowledgeHabit(owner: String, uuid: String) { if (owner == account) queue.removeAll { it.uuid == uuid } }
    override fun habitError(owner: String) = error.takeIf { owner == account }
    override fun setHabitError(owner: String, message: String?) { if (owner == account) error = message }
}

private fun habitsFixture(done: Boolean = false) = HabitsResponse(DAY, listOf(Habit(
    HABIT, "Pushups", "day", 1, done, HabitProgress(if (done) 1 else 0, 1, DAY, DAY), listOf(HabitDay(DAY, done)),
)))
private fun asJson(response: HabitsResponse): JsonElement = Json.encodeToJsonElement(HabitsResponse.serializer(), response)

class HabitsTest {
    @Test fun checkInSurvivesNetworkFailureAndProcessRestart() = runBlocking {
        val store = HabitMemory()
        val first = HabitSync(store, { store.account }) { _, _, _ -> throw IOException("offline") }
        first.checkIn("one", HABIT, DAY, true)
        val uuid = store.queue.single().uuid
        try { first.sync(); fail() } catch (_: IOException) { }
        assertEquals(uuid, store.queue.single().uuid)
        assertTrue(habitRows(store.cache, store.queue, DAY, "monday").single().completed)
        var puts = 0
        val restarted = HabitSync(store, { store.account }) { method, path, body ->
            if (method == "PUT") {
                puts++
                assertEquals("/api/v1/habits/$HABIT/check-ins/$DAY", path)
                assertTrue(body!!.getValue("completed").jsonPrimitive.boolean)
            }
            asJson(habitsFixture(true))
        }
        restarted.sync()
        assertEquals(1, puts)
        assertTrue(store.queue.isEmpty())
        assertTrue(store.cache!!.habits.single().todayCompleted)
    }

    @Test fun successfulPutKeepsTheCheckboxWhenTheFollowingGetFails() = runBlocking {
        val store = HabitMemory()
        val sync = HabitSync(store, { store.account }) { method, _, _ ->
            if (method == "GET") throw IOException("connection lost after PUT")
            asJson(habitsFixture(true))
        }
        sync.checkIn("one", HABIT, DAY, true)
        try { sync.sync(); fail() } catch (_: IOException) { }
        assertEquals(1, store.queue.size)
        assertTrue(habitRows(store.cache, store.queue, DAY, "monday").single().completed)
    }

    @Test fun acknowledgementPreservesAToggleQueuedDuringTheRequest() = runBlocking {
        val store = HabitMemory()
        lateinit var sync: HabitSync
        val desired = mutableListOf<Boolean>()
        sync = HabitSync(store, { store.account }) { method, _, body ->
            if (method == "PUT") {
                desired += body!!.getValue("completed").jsonPrimitive.boolean
                if (desired.size == 1) sync.checkIn("one", HABIT, DAY, false)
            }
            asJson(habitsFixture(desired.lastOrNull() ?: false))
        }
        sync.checkIn("one", HABIT, DAY, true)
        sync.sync()
        assertEquals(1, store.queue.size)
        assertFalse(habitRows(store.cache, store.queue, DAY, "monday").single().completed)
        sync.sync()
        assertEquals(listOf(true, false), desired)
        assertTrue(store.queue.isEmpty())
        assertFalse(store.cache!!.habits.single().todayCompleted)
    }

    @Test fun permanentRefusalRollsBackAndExposesAnError() = runBlocking {
        val store = HabitMemory()
        val sync = HabitSync(store, { store.account }) { method, _, _ ->
            if (method == "PUT") throw ServerException(404, "not_found")
            asJson(HabitsResponse(DAY, emptyList()))
        }
        sync.checkIn("one", HABIT, DAY, true)
        sync.sync()
        assertTrue(store.queue.isEmpty())
        assertTrue(store.cache!!.habits.isEmpty())
        assertNotNull(store.error)
    }

    @Test fun serverFailureRetainsTheDesiredState() = runBlocking {
        val store = HabitMemory()
        val sync = HabitSync(store, { store.account }) { _, _, _ -> throw ServerException(503, null) }
        sync.checkIn("one", HABIT, DAY, true)
        try { sync.sync(); fail() } catch (_: ServerException) { }
        assertEquals(1, store.queue.size)
    }

    @Test fun staleWidgetActionsAndResponsesCannotCrossAccounts() = runBlocking {
        val store = HabitMemory()
        val sync = HabitSync(store, { store.account }) { _, _, _ ->
            store.account = "two"
            store.cache = HabitsResponse(DAY, emptyList())
            asJson(habitsFixture(true))
        }
        sync.checkIn("old-account", HABIT, DAY, true)
        assertTrue(store.queue.isEmpty())
        sync.sync()
        assertTrue(store.cache!!.habits.isEmpty())
    }

    @Test fun midnightResetsTodayWithoutChangingTheQueuedDate() {
        val response = habitsFixture(true)
        val next = habitRows(response, emptyList(), "2026-11-07", "monday").single()
        assertFalse(next.completed)
        assertEquals(0, next.progress)
        val pending = listOf(HabitCheckIn("q", HABIT, DAY, true))
        assertFalse(habitRows(response, pending, "2026-11-07", "monday").single().completed)
        assertEquals(DAY, pending.single().date)
    }

    @Test fun weeklyProgressUsesTheAccountWeekStartAndDesiredState() {
        val weekly = habitsFixture().habits.single().copy(period = "week", target = 3,
            history = listOf(HabitDay("2026-11-01", true), HabitDay("2026-11-02", true), HabitDay("2026-11-06", false)))
        val response = HabitsResponse(DAY, listOf(weekly))
        val queued = listOf(HabitCheckIn("q", HABIT, DAY, true))
        assertEquals(3, habitRows(response, queued, DAY, "sunday").single().progress)
        assertEquals(2, habitRows(response, queued, DAY, "monday").single().progress)
        assertTrue(habitRows(response, queued, DAY, "sunday").single().pending)
    }

    @Test fun decodingAcceptsServerMetadataAndEmptyLists() {
        val decoded = Json.decodeFromString(HabitsResponse.serializer(), """{"today":"$DAY","habits":[],"extra":"future"}""")
        assertTrue(decoded.habits.isEmpty())
    }
}
