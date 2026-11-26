package com.bokyapps.bokydo

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.HabitRow
import com.bokyapps.bokydo.core.habitRows
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private data class HabitSnapshot(val account: String?, val rows: List<HabitRow>?, val error: String? = null)

/** One account-bound cache/queue feeds the tracker and both task-list overviews. */
@Composable
private fun rememberHabitSnapshot(state: AppState, today: String): HabitSnapshot {
    val app = LocalContext.current.app
    val version by app.store.version.collectAsState()
    val account = app.accountEpoch()
    val weekStart = state.user?.prefs?.weekStart ?: "monday"
    val snapshot by produceState(HabitSnapshot(null, null), version, today, account, weekStart) {
        value = withContext(Dispatchers.IO) {
            if (account == null) HabitSnapshot(null, null) else {
                val cached = app.store.cachedHabits(account)
                HabitSnapshot(account,
                    cached?.let { habitRows(it, app.store.pendingHabits(account), today, weekStart) },
                    app.store.habitError(account))
            }
        }
    }
    return if (snapshot.account == account) snapshot else HabitSnapshot(account, null)
}

@Composable
private fun HabitCheckInRow(row: HabitRow, account: String?, today: String) {
    val app = LocalContext.current.app
    val scope = rememberCoroutineScope()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = row.completed, enabled = account != null,
            modifier = Modifier.semantics { contentDescription = "Today: ${row.name}" },
            onCheckedChange = { completed ->
                account?.let { owner -> scope.launch(Dispatchers.IO) { app.checkInHabit(owner, row.id, today, completed) } }
            })
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.name, style = MaterialTheme.typography.titleMedium)
            Text("${row.progress}/${row.target} ${if (row.period == "day") "today" else "this week"}${if (row.pending) " · waiting to sync" else ""}", style = MaterialTheme.typography.bodySmall)
            LinearProgressIndicator(progress = { (row.progress.toFloat() / row.target.coerceAtLeast(1)).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
        }
    }
}

/** A separate tinted section, even when the task list is empty. Hiding is local to each view. */
@Composable
fun HabitOverview(state: AppState, today: String, view: String, onOpen: () -> Unit) {
    val app = LocalContext.current.app
    val owner = "${app.sessions.load()?.origin}|${state.user?.id}"
    var visible by remember(owner, view) { mutableStateOf(app.device.habitOverviewVisible(owner, view)) }
    fun setVisible(on: Boolean) {
        app.device.setHabitOverviewVisible(owner, view, on)
        visible = on
    }
    if (!visible) {
        TextButton(onClick = { setVisible(true) }, modifier = Modifier.padding(16.dp)) { Text("Show habits") }
        return
    }
    val snapshot = rememberHabitSnapshot(state, today)
    val syncError by app.syncError.collectAsState()
    OutlinedCard(
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 16.dp),
        colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.35f)),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.4f)),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("↻ Habits", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
                TextButton(onClick = { setVisible(false) }) { Text("Hide habits") }
            }
            (snapshot.error ?: syncError)?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
                OutlinedButton(onClick = { app.syncNow() }) { Text("Retry habits sync") }
            }
            if (snapshot.rows == null) Text("Loading habits…")
            if (snapshot.rows?.isEmpty() == true) Text("No habits yet. Open Manage habits to start tracking.")
            for (row in snapshot.rows.orEmpty()) HabitCheckInRow(row, snapshot.account, today)
            TextButton(onClick = onOpen, modifier = Modifier.align(Alignment.End)) { Text("Manage habits") }
        }
    }
}

@Composable
fun HabitsScreen(state: AppState, today: String) {
    val context = LocalContext.current
    val app = context.app
    val snapshot = rememberHabitSnapshot(state, today)
    val syncError by app.syncError.collectAsState()
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(16.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(today, style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = { app.syncNow() }) { Text("Refresh") }
            }
        }
        syncError?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
        snapshot.error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
        if (snapshot.rows == null) item { Text("Loading habits…") }
        if (snapshot.rows?.isEmpty() == true) item { Text("No habits yet. Add one in Manage habits to start tracking.") }
        items(snapshot.rows.orEmpty(), key = { it.id }) { row -> HabitCheckInRow(row, snapshot.account, today) }
        item {
            Button(onClick = {
                val origin = app.sessions.load()?.origin ?: return@Button
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$origin/habits")))
            }) { Text("Manage habits") }
        }
    }
}
