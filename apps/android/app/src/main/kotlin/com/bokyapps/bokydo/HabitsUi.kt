package com.bokyapps.bokydo

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.HabitRow
import com.bokyapps.bokydo.core.habitRows
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun HabitsScreen(state: AppState, today: String) {
    val context = LocalContext.current
    val app = context.app
    val version by app.store.version.collectAsState()
    val syncError by app.syncError.collectAsState()
    val account = app.accountEpoch()
    val scope = rememberCoroutineScope()
    val rows by produceState<List<HabitRow>?>(null, version, today, account) {
        value = withContext(Dispatchers.IO) {
            account?.let { habitRows(app.store.cachedHabits(it), app.store.pendingHabits(it), today, state.user?.prefs?.weekStart ?: "monday") }
        }
    }
    val error by produceState<String?>(null, version, account) {
        value = withContext(Dispatchers.IO) { account?.let { app.store.habitError(it) } }
    }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(16.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(today, style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = { app.syncNow() }) { Text("Refresh") }
            }
        }
        syncError?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
        error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
        if (rows == null) item { Text("Loading habits…") }
        if (rows?.isEmpty() == true) item { Text("No habits yet. Add one in Manage habits to start tracking.") }
        items(rows.orEmpty(), key = { it.id }) { row ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = row.completed, onCheckedChange = { completed ->
                    account?.let { owner -> scope.launch(Dispatchers.IO) { app.checkInHabit(owner, row.id, today, completed) } }
                })
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(row.name, style = MaterialTheme.typography.titleMedium)
                    Text("${row.progress}/${row.target} ${if (row.period == "day") "today" else "this week"}${if (row.pending) " · waiting to sync" else ""}")
                    LinearProgressIndicator(progress = { (row.progress.toFloat() / row.target.coerceAtLeast(1)).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                }
            }
        }
        item {
            Button(onClick = {
                val origin = app.sessions.load()?.origin ?: return@Button
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$origin/habits")))
            }) { Text("Manage habits") }
        }
    }
}
