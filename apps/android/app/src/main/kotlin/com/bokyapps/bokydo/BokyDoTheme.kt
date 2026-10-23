package com.bokyapps.bokydo

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import com.bokyapps.bokydo.core.Appearance
import com.bokyapps.bokydo.core.BundledFonts
import com.bokyapps.bokydo.core.ThemeTokens
import com.bokyapps.bokydo.core.Themes

/** Compact lists (the "density" setting). */
val LocalCompact = staticCompositionLocalOf { false }

/** The tokens of the theme in use, so the lists can use its priority and project colours. */
val LocalThemeTokens = staticCompositionLocalOf { Themes.all.first().tokens }

/**
 * The app's theme, built from the web's tokens (PLAN §4a): the user's synced appearance picks
 * the theme variant, the system setting picks between light and dark, and Material You (dynamic
 * colour) is an extra, device-local choice.
 */
@Composable
fun BokyDoTheme(
    appearance: Appearance,
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val dark = when (appearance.mode) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val tokens = themeTokens(appearance, dark)
    val context = LocalContext.current
    val scheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        else -> colorScheme(tokens)
    }
    CompositionLocalProvider(
        LocalCompact provides (appearance.density == "compact"),
        LocalThemeTokens provides tokens,
    ) {
        MaterialTheme(
            colorScheme = scheme,
            typography = typography(appearance),
            content = content,
        )
    }
}

/** The tokens of the chosen theme, falling back to BokyDo's own light/dark defaults. */
private fun themeTokens(appearance: Appearance, dark: Boolean): ThemeTokens {
    val id = if (dark) appearance.darkTheme else appearance.lightTheme
    val theme = Themes.byId(id) ?: Themes.byId(if (dark) "bokydo-dark" else "bokydo-light")
    return theme?.tokens ?: Themes.all.first().tokens
}

/**
 * The web's semantic tokens as a Compose scheme. Every colour is set, so Material's purple
 * defaults never show through and the light and dark variants look the same on the phone.
 */
private fun colorScheme(t: ThemeTokens): ColorScheme {
    val accent = Color(t.accent)
    val accentFg = Color(t.accentFg)
    val bg = Color(t.bg)
    val surface = Color(t.surface)
    val surfaceAlt = Color(t.surfaceAlt)
    val fg = Color(t.fg)
    val muted = Color(t.muted)
    val danger = Color(t.danger)
    return lightColorScheme(
        primary = accent,
        onPrimary = accentFg,
        primaryContainer = accent,
        onPrimaryContainer = accentFg,
        inversePrimary = accent,
        secondary = Color(t.p3),
        onSecondary = bg,
        secondaryContainer = surfaceAlt,
        onSecondaryContainer = fg,
        tertiary = Color(t.p2),
        onTertiary = bg,
        tertiaryContainer = surfaceAlt,
        onTertiaryContainer = fg,
        background = bg,
        onBackground = fg,
        surface = surface,
        onSurface = fg,
        surfaceVariant = surfaceAlt,
        onSurfaceVariant = muted,
        surfaceTint = accent,
        inverseSurface = fg,
        inverseOnSurface = bg,
        error = danger,
        onError = bg,
        errorContainer = danger,
        onErrorContainer = bg,
        outline = Color(t.border),
        outlineVariant = Color(t.border),
        scrim = fg,
        surfaceBright = surface,
        surfaceDim = bg,
        surfaceContainer = surfaceAlt,
        surfaceContainerHigh = surfaceAlt,
        surfaceContainerHighest = surfaceAlt,
        surfaceContainerLow = surface,
        surfaceContainerLowest = bg,
    )
}

/** The bundled font family for a font id (the system font needs no file). */
@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun fontFamily(id: String): FontFamily {
    if (id == "system") return FontFamily.Default
    val resource = when (BundledFonts.files[id]) {
        "inter" -> R.font.inter
        "ibm_plex_sans" -> R.font.ibm_plex_sans
        "atkinson" -> R.font.atkinson
        "lexend" -> R.font.lexend
        "opendyslexic" -> R.font.opendyslexic
        "jetbrains_mono" -> R.font.jetbrains_mono
        "fira_code" -> R.font.fira_code
        else -> return FontFamily.Default
    }
    if (id !in BundledFonts.variable) return FontFamily(Font(resource, FontWeight.Normal))
    // A variable font: ask for the weight instead of faking it.
    return FontFamily(
        Font(
            resource,
            FontWeight.Normal,
            variationSettings = FontVariation.Settings(FontVariation.weight(400)),
        ),
        Font(
            resource,
            FontWeight.SemiBold,
            variationSettings = FontVariation.Settings(FontVariation.weight(600)),
        ),
    )
}

/** The type scale: the chosen family, at the chosen text size. */
private fun typography(appearance: Appearance): Typography {
    val family = fontFamily(appearance.font)
    val scale = when (appearance.textSize) {
        "small" -> 0.875f
        "large" -> 1.125f
        "larger" -> 1.25f
        else -> 1f
    }
    val base = Typography()
    fun TextStyle.scaled() = copy(fontFamily = family, fontSize = fontSize * scale)
    return Typography(
        displayLarge = base.displayLarge.scaled(),
        displayMedium = base.displayMedium.scaled(),
        displaySmall = base.displaySmall.scaled(),
        headlineLarge = base.headlineLarge.scaled(),
        headlineMedium = base.headlineMedium.scaled(),
        headlineSmall = base.headlineSmall.scaled(),
        titleLarge = base.titleLarge.scaled(),
        titleMedium = base.titleMedium.scaled(),
        titleSmall = base.titleSmall.scaled(),
        bodyLarge = base.bodyLarge.scaled(),
        bodyMedium = base.bodyMedium.scaled(),
        bodySmall = base.bodySmall.scaled(),
        labelLarge = base.labelLarge.scaled(),
        labelMedium = base.labelMedium.scaled(),
        labelSmall = base.labelSmall.scaled(),
    )
}
