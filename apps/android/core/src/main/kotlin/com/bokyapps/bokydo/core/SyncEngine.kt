package com.bokyapps.bokydo.core

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The device's copy of the user's data plus the queue of changes not yet confirmed. On
 * Android this is SQLite; tests use [MemoryStore]. Implementations apply a response atomically.
 */
interface LocalStore {
    fun cursor(): String?
    fun pending(limit: Int): List<Command>
    fun enqueue(command: Command)

    /**
     * Merge a response: replace everything on a full sync, otherwise upsert and remove; replace
     * the snapshots; save the cursor; drop `sent` commands the server answered (rejections are
     * kept in a list the UI can show). All or nothing.
     */
    fun apply(response: SyncResponse, sent: List<Command>)
    fun rejected(): List<Rejection>

    /** Forget everything (sign-out). */
    fun clear()
}

data class Rejection(val command: Command, val error: String, val message: String?)

data class SyncOutcome(val rounds: Int, val rejected: Int, val fullSync: Boolean)

/**
 * Sync: send queued commands (in order, at most 100 per request, the server's limit) and merge
 * what changed. One sync runs at a time. Commands stay queued until the server has answered
 * them, so a dropped connection never loses a change; command UUIDs make resending safe (the
 * server returns the first result for a replayed UUID).
 */
class SyncEngine(private val client: BokyDoClient, private val store: LocalStore) {
    private val lock = Mutex()

    suspend fun sync(): SyncOutcome = lock.withLock { syncLocked() }

    private suspend fun syncLocked(): SyncOutcome {
        var rounds = 0
        var rejected = 0
        var fullSync = false
        do {
            val batch = store.pending(MAX_COMMANDS_PER_SYNC)
            val response = client.sync(SyncRequest(store.cursor(), batch))
            store.apply(response, batch)
            rejected += batch.count { response.results[it.uuid]?.ok == false }
            fullSync = fullSync || response.fullSync
            rounds++
            // More queued than fit in one request (or queued meanwhile): keep going, boundedly.
        } while (store.pending(1).isNotEmpty() && rounds < MAX_ROUNDS)
        return SyncOutcome(rounds, rejected, fullSync)
    }

    fun enqueue(type: String, args: JsonObject, uuid: String = Ids.newId()) {
        store.enqueue(Command(type, uuid, args))
    }

    companion object {
        const val MAX_COMMANDS_PER_SYNC = 100
        const val MAX_ROUNDS = 20
    }
}

/** In-memory [LocalStore], for tests and as the reference for the merge rules. */
class MemoryStore : LocalStore {
    private var cursor: String? = null
    val entities: Map<String, MutableMap<String, JsonObject>> =
        ENTITY_TYPES.associateWith { mutableMapOf<String, JsonObject>() }
    val snapshots = mutableMapOf<String, JsonElement>()
    private val queue = mutableListOf<Command>()
    private val rejections = mutableListOf<Rejection>()

    override fun cursor() = cursor
    override fun pending(limit: Int) = queue.take(limit)
    override fun enqueue(command: Command) {
        queue += command
    }

    override fun apply(response: SyncResponse, sent: List<Command>) {
        if (response.fullSync) entities.values.forEach { it.clear() }
        for ((type, list) in response.entities) {
            val table = entities.getValue(type)
            for (e in list) table[e.id()] = e
        }
        for ((type, ids) in response.removed) ids.forEach { entities.getValue(type).remove(it) }
        snapshots.putAll(response.snapshots)
        cursor = response.cursor
        for (c in sent) {
            val result = response.results[c.uuid] ?: continue
            queue.remove(c)
            if (!result.ok) rejections += Rejection(c, result.error ?: "rejected", result.message)
        }
    }

    override fun rejected() = rejections.toList()
    override fun clear() {
        cursor = null
        entities.values.forEach { it.clear() }
        snapshots.clear()
        queue.clear()
        rejections.clear()
    }
}

fun JsonObject.id(): String =
    (this["id"] as? JsonPrimitive)?.content ?: throw ProtocolException("entity without id")
