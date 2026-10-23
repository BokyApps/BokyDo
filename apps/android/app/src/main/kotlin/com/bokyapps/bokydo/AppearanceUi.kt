package com.bokyapps.bokydo

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.Appearance
import com.bokyapps.bokydo.core.ThemeDef
import com.bokyapps.bokydo.core.Themes
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Settings → Appearance (PLAN §4a): the theme family and its variants, the mode (system, light
 * or dark), the font, the text size and the density. Everything but Material You's dynamic
 * colour is the user's synced setting, so the web app follows it too.
 */
@Composable
fun AppearanceSection(state: AppState) {
    val app = LocalContext.current.app
    val appearance = state.user?.prefs?.appearance ?: Appearance.DEFAULT
    val dynamic by app.device.dynamicColor.collectAsState()

    fun update(patch: JsonObject) {
        app.sendAll(listOf("user_update_preferences" to buildJsonObject { put("appearance", patch) }))
    }

    Text("Theme", style = MaterialTheme.typography.titleMedium)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (mode in Appearance.MODES) {
            FilterChip(
                selected = appearance.mode == mode,
                onClick = { update(buildJsonObject { put("mode", mode) }) },
                label = { Text(if (mode == "system") "System" else mode.replaceFirstChar { it.uppercase() }) },
            )
        }
    }
    Text(
        "The theme family to use; its light and dark variants can be picked separately below.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    for (family in Themes.families) {
        val light = Themes.byId(family.defaultLight)
        val dark = Themes.byId(family.defaultDark)
        val selected = Themes.byId(appearance.lightTheme)?.family == family.id ||
            Themes.byId(appearance.darkTheme)?.family == family.id
        Column(
            Modifier
                .fillMaxWidth()
                .border(
                    width = if (selected) 2.dp else 1.dp,
                    color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                    shape = MaterialTheme.shapes.small,
                )
                .clickable {
                    update(
                        buildJsonObject {
                            put("lightTheme", family.defaultLight)
                            put("darkTheme", family.defaultDark)
                        },
                    )
                }
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (tokens in listOfNotNull(light?.tokens, dark?.tokens)) {
                    Row(
                        Modifier.background(Color(tokens.bg), MaterialTheme.shapes.extraSmall).padding(4.dp),
                        horizontalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        for (color in listOf(tokens.accent, tokens.p1, tokens.p2, tokens.p3)) {
                            Box(
                                Modifier.size(10.dp).background(Color(color), CircleShape),
                            )
                        }
                    }
                }
            }
            Text(family.name, style = MaterialTheme.typography.bodyLarge)
        }
    }
    ChoiceRow(
        label = "Light variant",
        value = themeLabel(appearance.lightTheme),
        options = Themes.ofMode("light").map { themeLabel(it.id) },
        onPick = { label ->
            val theme = Themes.ofMode("light").firstOrNull { themeLabel(it.id) == label } ?: return@ChoiceRow
            update(buildJsonObject { put("lightTheme", theme.id) })
        },
    )
    ChoiceRow(
        label = "Dark variant",
        value = themeLabel(appearance.darkTheme),
        options = Themes.ofMode("dark").map { themeLabel(it.id) },
        onPick = { label ->
            val theme = Themes.ofMode("dark").firstOrNull { themeLabel(it.id) == label } ?: return@ChoiceRow
            update(buildJsonObject { put("darkTheme", theme.id) })
        },
    )
    ChoiceRow(
        label = "Font",
        value = Appearance.FONTS[appearance.font] ?: "System",
        options = Appearance.FONTS.values.toList(),
        onPick = { label ->
            val id = Appearance.FONTS.entries.firstOrNull { it.value == label }?.key ?: return@ChoiceRow
            update(buildJsonObject { put("font", id) })
        },
    )
    Text("Text size", style = MaterialTheme.typography.titleMedium)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (size in Appearance.TEXT_SIZES) {
            FilterChip(
                selected = appearance.textSize == size,
                onClick = { update(buildJsonObject { put("textSize", size) }) },
                label = { Text(size.replaceFirstChar { it.uppercase() }) },
            )
        }
    }
    Text("Density", style = MaterialTheme.typography.titleMedium)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (density in Appearance.DENSITIES) {
            FilterChip(
                selected = appearance.density == density,
                onClick = { update(buildJsonObject { put("density", density) }) },
                label = { Text(density.replaceFirstChar { it.uppercase() }) },
            )
        }
    }
    Row(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Material You colours", style = MaterialTheme.typography.bodyLarge)
            Text(
                "Follow the wallpaper's colours on this phone. This one stays on the device.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = dynamic, onCheckedChange = { app.device.setDynamicColor(it) })
    }
}

/** "Catppuccin Mocha" — the family and variant names together. */
private fun themeLabel(id: String): String {
    val theme: ThemeDef = Themes.byId(id) ?: return id
    val family = Themes.family(theme.family)?.name ?: theme.family
    return "$family ${theme.name}"
}

/** A row that opens a dialog with the choices. */
@Composable
private fun ChoiceRow(label: String, value: String, options: List<String>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            value,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.clickable { open = true },
        )
    }
    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text(label) },
            text = {
                LazyColumn {
                    items(options) { option ->
                        Text(
                            option,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.fillMaxWidth().clickable {
                                open = false
                                onPick(option)
                            }.padding(vertical = 10.dp),
                        )
                    }
                }
            },
            confirmButton = { TextButton(onClick = { open = false }) { Text("Close") } },
        )
    }
}
