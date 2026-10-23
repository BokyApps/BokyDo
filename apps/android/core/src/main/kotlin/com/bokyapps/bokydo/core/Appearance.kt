package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The user's appearance settings (PLAN §4a): the theme to use in light and dark mode, the font,
 * the text size and the density. Synced with the web app, so a phone follows the browser's
 * choice. The colours themselves come from the generated [Themes] tokens.
 */
data class Appearance(
    val mode: String,
    val lightTheme: String,
    val darkTheme: String,
    val font: String,
    val textSize: String,
    val density: String,
) {
    companion object {
        val DEFAULT = Appearance("system", "bokydo-light", "bokydo-dark", "system", "default", "comfortable")

        val MODES = listOf("system", "light", "dark")
        val TEXT_SIZES = listOf("small", "default", "large", "larger")
        val DENSITIES = listOf("comfortable", "compact")

        /** The font choices: id → the name shown in the settings. */
        val FONTS: Map<String, String> = BundledFonts.names

        /** Read the appearance from the user's preferences; anything unknown falls back. */
        fun from(o: JsonObject?): Appearance {
            if (o == null) return DEFAULT
            fun str(key: String): String? = (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val mode = str("mode")?.takeIf { it in MODES } ?: DEFAULT.mode
            val light = str("lightTheme")?.takeIf { Themes.byId(it) != null } ?: DEFAULT.lightTheme
            val dark = str("darkTheme")?.takeIf { Themes.byId(it) != null } ?: DEFAULT.darkTheme
            val font = str("font")?.takeIf { it in FONTS } ?: DEFAULT.font
            val size = str("textSize")?.takeIf { it in TEXT_SIZES } ?: DEFAULT.textSize
            val density = str("density")?.takeIf { it in DENSITIES } ?: DEFAULT.density
            return Appearance(mode, light, dark, font, size, density)
        }

        /** Apply a patch (as the server does: the fields it carries, the rest unchanged). */
        fun merge(base: Appearance, patch: JsonObject): Appearance {
            val merged = buildMap {
                put("mode", JsonPrimitive(base.mode))
                put("lightTheme", JsonPrimitive(base.lightTheme))
                put("darkTheme", JsonPrimitive(base.darkTheme))
                put("font", JsonPrimitive(base.font))
                put("textSize", JsonPrimitive(base.textSize))
                put("density", JsonPrimitive(base.density))
                for ((k, v) in patch) if (k in ALL_KEYS) put(k, v)
            }
            return from(JsonObject(merged))
        }

        private val ALL_KEYS = listOf("mode", "lightTheme", "darkTheme", "font", "textSize", "density")
    }
}
