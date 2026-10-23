package com.bokyapps.bokydo

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.bokyapps.bokydo.core.ZoneOption
import com.bokyapps.bokydo.core.TimeZones

/**
 * The time-zone picker (PLAN §4b): the same detection and smart search as the web — city,
 * country, alias, abbreviation, offset or IANA name — with the zone's current offset and time.
 */
@Composable
fun TimeZoneScreen(current: String?, onPick: (String) -> Unit, onBack: () -> Unit) {
    var query by remember { mutableStateOf("") }
    val detected = remember { TimeZones.detect() }
    val results = remember(query) { TimeZones.search(query, limit = 60) }
    val currentZone = current?.let { runCatching { TimeZones.describe(it) }.getOrNull() }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("Search a city, country or offset") },
            placeholder = { Text("+7, SAST, Phnom Penh, Asia/Bangkok") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
        currentZone?.let {
            Text(
                "Current: ${describe(it)} (${it.offsetLabel}, ${it.localTime} now)",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        if (detected != null && detected != current) {
            val zone = remember(detected) { TimeZones.describe(detected) }
            Text(
                "Use detected: ${describe(zone)} (${zone.offsetLabel})",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.clickable { onPick(detected) }.padding(vertical = 8.dp),
            )
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(results, key = { it.id }) { zone ->
                Row(
                    Modifier.fillMaxWidth().clickable { onPick(zone.id) }.padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(describe(zone), style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(zone.id, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(
                        "${zone.offsetLabel} · ${zone.localTime}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** "Phnom Penh, Cambodia" */
private fun describe(zone: ZoneOption): String =
    listOf(zone.city, zone.country).filter { it.isNotEmpty() }.joinToString(", ")

/**
 * The travel prompt: the phone's zone differs from the saved one, so offer to switch (once per
 * zone, as the web does).
 */
@Composable
fun TravelPrompt(zone: ZoneOption, onSwitch: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("You're in ${zone.offsetLabel} now") },
        text = {
            Text(
                "This phone is on ${describe(zone)} (${zone.offsetLabel}, ${zone.localTime}). " +
                    "Switch your time zone?",
            )
        },
        confirmButton = { TextButton(onClick = onSwitch) { Text("Switch") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Not now") } },
    )
}
