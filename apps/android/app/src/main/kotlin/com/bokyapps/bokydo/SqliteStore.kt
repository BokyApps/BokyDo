package com.bokyapps.bokydo

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.bokyapps.bokydo.core.Command
import com.bokyapps.bokydo.core.ENTITY_TYPES
import com.bokyapps.bokydo.core.Json
import com.bokyapps.bokydo.core.LocalStore
import com.bokyapps.bokydo.core.Rejection
import com.bokyapps.bokydo.core.SyncResponse
import com.bokyapps.bokydo.core.id
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * The device copy of the user's data, mirroring the sync model: one table of entities (by type
 * and id, stored as the server's JSON so new fields survive), the complete snapshots, the cursor,
 * and the queue of commands waiting for the server. Same merge rules as [MemoryStore] (core),
 * which the unit tests pin down. Plain SQLite rather than Room: no annotation processing in the
 * build, and screens read the state into memory like the web app does (ADR 0010).
 */
class SqliteStore(context: Context) : LocalStore {
    private val helper = object : SQLiteOpenHelper(context, "bokydo.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("create table entities (type text not null, id text not null, json text not null, primary key (type, id))")
            db.execSQL("create table snapshots (name text primary key, json text not null)")
            db.execSQL("create table meta (key text primary key, value text not null)")
            db.execSQL("create table queue (seq integer primary key autoincrement, uuid text not null unique, type text not null, args text not null)")
            db.execSQL("create table rejections (uuid text primary key, type text not null, args text not null, error text not null, message text, at integer not null)")
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }

    private val _version = MutableStateFlow(0L)
    /** Bumped after every change, so screens know to re-read. */
    val version: StateFlow<Long> = _version

    private fun changed() {
        _version.value = _version.value + 1
    }

    override fun cursor(): String? =
        helper.readableDatabase.rawQuery("select value from meta where key = 'cursor'", null).use {
            if (it.moveToFirst()) it.getString(0) else null
        }

    override fun pending(limit: Int): List<Command> =
        helper.readableDatabase.rawQuery("select type, uuid, args from queue order by seq limit ?", arrayOf(limit.toString())).use {
            buildList {
                while (it.moveToNext()) {
                    add(Command(it.getString(0), it.getString(1), Json.parseToJsonElement(it.getString(2)) as JsonObject))
                }
            }
        }

    override fun enqueue(command: Command) {
        helper.writableDatabase.insertOrThrow(
            "queue",
            null,
            ContentValues().apply {
                put("uuid", command.uuid)
                put("type", command.type)
                put("args", command.args.toString())
            },
        )
        changed()
    }

    override fun apply(response: SyncResponse, sent: List<Command>) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            if (response.fullSync) db.delete("entities", null, null)
            for ((type, list) in response.entities) {
                for (e in list) {
                    db.insertWithOnConflict(
                        "entities",
                        null,
                        ContentValues().apply {
                            put("type", type)
                            put("id", e.id())
                            put("json", e.toString())
                        },
                        SQLiteDatabase.CONFLICT_REPLACE,
                    )
                }
            }
            for ((type, ids) in response.removed) {
                for (id in ids) db.delete("entities", "type = ? and id = ?", arrayOf(type, id))
            }
            for ((name, value) in response.snapshots) {
                db.insertWithOnConflict(
                    "snapshots",
                    null,
                    ContentValues().apply {
                        put("name", name)
                        put("json", value.toString())
                    },
                    SQLiteDatabase.CONFLICT_REPLACE,
                )
            }
            db.insertWithOnConflict(
                "meta",
                null,
                ContentValues().apply {
                    put("key", "cursor")
                    put("value", response.cursor)
                },
                SQLiteDatabase.CONFLICT_REPLACE,
            )
            db.insertWithOnConflict(
                "meta",
                null,
                ContentValues().apply {
                    put("key", "syncedAt")
                    put("value", System.currentTimeMillis().toString())
                },
                SQLiteDatabase.CONFLICT_REPLACE,
            )
            for (c in sent) {
                val result = response.results[c.uuid] ?: continue
                db.delete("queue", "uuid = ?", arrayOf(c.uuid))
                if (!result.ok) {
                    db.insertWithOnConflict(
                        "rejections",
                        null,
                        ContentValues().apply {
                            put("uuid", c.uuid)
                            put("type", c.type)
                            put("args", c.args.toString())
                            put("error", result.error ?: "rejected")
                            put("message", result.message)
                            put("at", System.currentTimeMillis())
                        },
                        SQLiteDatabase.CONFLICT_REPLACE,
                    )
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        changed()
    }

    override fun rejected(): List<Rejection> =
        helper.readableDatabase.rawQuery("select type, uuid, args, error, message from rejections order by at", null).use {
            buildList {
                while (it.moveToNext()) {
                    val command = Command(it.getString(0), it.getString(1), Json.parseToJsonElement(it.getString(2)) as JsonObject)
                    add(Rejection(command, it.getString(3), if (it.isNull(4)) null else it.getString(4)))
                }
            }
        }

    override fun clear() {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            for (t in listOf("entities", "snapshots", "meta", "queue", "rejections")) db.delete(t, null, null)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        changed()
    }

    fun count(type: String): Int {
        require(type in ENTITY_TYPES)
        return helper.readableDatabase.rawQuery("select count(*) from entities where type = ?", arrayOf(type)).use {
            it.moveToFirst()
            it.getInt(0)
        }
    }

    /** Every synced entity of a type (e.g. all reminders), as stored. */
    fun all(type: String): List<JsonObject> {
        require(type in ENTITY_TYPES)
        return helper.readableDatabase.rawQuery("select json from entities where type = ?", arrayOf(type)).use {
            buildList {
                while (it.moveToNext()) (Json.parseToJsonElement(it.getString(0)) as? JsonObject)?.let(::add)
            }
        }
    }

    fun snapshot(name: String): JsonElement =
        helper.readableDatabase.rawQuery("select json from snapshots where name = ?", arrayOf(name)).use {
            if (it.moveToFirst()) Json.parseToJsonElement(it.getString(0)) else JsonNull
        }

    fun syncedAt(): Long? =
        helper.readableDatabase.rawQuery("select value from meta where key = 'syncedAt'", null).use {
            if (it.moveToFirst()) it.getString(0).toLongOrNull() else null
        }

    fun pendingCount(): Int =
        helper.readableDatabase.rawQuery("select count(*) from queue", null).use {
            it.moveToFirst()
            it.getInt(0)
        }
}
