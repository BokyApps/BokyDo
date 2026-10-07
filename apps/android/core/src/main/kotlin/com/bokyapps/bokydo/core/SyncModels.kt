package com.bokyapps.bokydo.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** The entity types synced as deltas (the server's ENTITY_TYPES). */
val ENTITY_TYPES = listOf("projects", "sections", "tasks", "labels", "filters", "comments", "reminders")

/**
 * Everything else in a sync response is sent complete every time and simply replaced
 * (`user`, collaborators, memberships, invitations, notifications, teams, folders).
 */
val SNAPSHOT_KEYS = listOf(
    "user",
    "collaborators",
    "members",
    "invitations",
    "notifications",
    "unreadNotifications",
    "workspaces",
    "workspaceMembers",
    "folders",
)

/** One queued change, exactly as the web app sends it (IDs are generated on the device). */
@Serializable
data class Command(val type: String, val uuid: String, val args: JsonObject)

@Serializable
data class SyncRequest(val cursor: String?, val commands: List<Command> = emptyList())

@Serializable
data class CommandResult(val ok: Boolean, val error: String? = null, val message: String? = null)

/**
 * The response, kept close to the wire format: entities stay JSON objects so the app is
 * forward compatible with fields added on the server; screens decode what they need.
 */
data class SyncResponse(
    val cursor: String,
    val fullSync: Boolean,
    val entities: Map<String, List<JsonObject>>,
    val removed: Map<String, List<String>>,
    val snapshots: Map<String, JsonElement>,
    val results: Map<String, CommandResult>,
) {
    companion object {
        fun fromJson(o: JsonObject): SyncResponse {
            fun str(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
                ?: throw ProtocolException("missing $k")
            val entities = ENTITY_TYPES.associateWith { type ->
                (o[type] as? kotlinx.serialization.json.JsonArray)?.map { it as JsonObject } ?: emptyList()
            }
            val removedObj = o["removed"] as? JsonObject ?: JsonObject(emptyMap())
            val removed = ENTITY_TYPES.associateWith { type ->
                (removedObj[type] as? kotlinx.serialization.json.JsonArray)?.map {
                    (it as kotlinx.serialization.json.JsonPrimitive).content
                } ?: emptyList()
            }
            val results = (o["results"] as? JsonObject ?: JsonObject(emptyMap())).mapValues { (_, v) ->
                Json.decodeFromJsonElement(CommandResult.serializer(), v)
            }
            return SyncResponse(
                cursor = str("cursor"),
                fullSync = (o["fullSync"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true",
                entities = entities,
                removed = removed,
                snapshots = SNAPSHOT_KEYS.associateWith { o[it] ?: JsonNull },
                results = results,
            )
        }
    }
}

class ProtocolException(message: String) : Exception(message)

/** Lenient where the server may add fields, strict about what we send. */
val Json = kotlinx.serialization.json.Json {
    ignoreUnknownKeys = true
    explicitNulls = true
    encodeDefaults = true
}
