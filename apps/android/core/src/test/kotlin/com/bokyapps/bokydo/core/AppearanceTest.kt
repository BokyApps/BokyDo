package com.bokyapps.bokydo.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class AppearanceTest {
    private val user = Json.parseToJsonElement(
        """{"id":"u1","username":"bob","inboxProjectId":"inbox","timeZone":"Europe/Lisbon",
           "preferences":{"weekStart":"monday","timeFormat":"24h","dateFormat":"dmy","smartDateRecognition":true,
             "timezone":"Asia/Bangkok",
             "appearance":{"mode":"dark","lightTheme":"catppuccin-latte","darkTheme":"catppuccin-mocha",
               "font":"inter","textSize":"large","density":"compact"}}}""",
    ) as kotlinx.serialization.json.JsonObject

    @Test
    fun readsTheAppearanceAndTheZoneFromTheSyncedUser() {
        val state = AppState.decode(emptyMap(), mapOf("user" to user))
        val prefs = state.user!!.prefs
        assertEquals("Asia/Bangkok", prefs.timezone)
        assertEquals("dark", prefs.appearance.mode)
        assertEquals("catppuccin-latte", prefs.appearance.lightTheme)
        assertEquals("catppuccin-mocha", prefs.appearance.darkTheme)
        assertEquals("inter", prefs.appearance.font)
        assertEquals("large", prefs.appearance.textSize)
        assertEquals("compact", prefs.appearance.density)
    }

    @Test
    fun fallsBackWhenTheAppearanceIsMissingOrUnknown() {
        assertEquals(Appearance.DEFAULT, Appearance.from(null))
        val odd = Appearance.from(
            buildJsonObject {
                put("mode", "purple")
                put("lightTheme", "no-such-theme")
                put("font", "comic-sans")
            },
        )
        assertEquals(Appearance.DEFAULT.mode, odd.mode)
        assertEquals(Appearance.DEFAULT.lightTheme, odd.lightTheme)
        assertEquals(Appearance.DEFAULT.font, odd.font)
    }

    @Test
    fun aPatchChangesOnlyWhatItCarries() {
        val base = Appearance.DEFAULT
        val merged = Appearance.merge(base, buildJsonObject { put("font", "lexend") })
        assertEquals("lexend", merged.font)
        assertEquals(base.mode, merged.mode)
        assertEquals(base.textSize, merged.textSize)
    }

    @Test
    fun theQueuedChangeShowsAtOnce() {
        val state = AppState.decode(emptyMap(), mapOf("user" to user))
        val command = Command(
            "user_update_preferences",
            Ids.newId(),
            buildJsonObject {
                put("appearance", buildJsonObject { put("font", "jetbrains-mono") })
                put("timezone", "Europe/Lisbon")
            },
        )
        val updated = Optimistic.apply(state, listOf(command))
        assertEquals("jetbrains-mono", updated.user?.prefs?.appearance?.font)
        assertEquals("Europe/Lisbon", updated.user?.prefs?.timezone)
        // The rest of the appearance is untouched.
        assertEquals("dark", updated.user?.prefs?.appearance?.mode)
    }
}
