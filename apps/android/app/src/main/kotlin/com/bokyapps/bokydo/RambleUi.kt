package com.bokyapps.bokydo

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.Dates
import com.bokyapps.bokydo.core.RambleApi
import com.bokyapps.bokydo.core.RambleDraft
import com.bokyapps.bokydo.core.ServerException
import com.bokyapps.bokydo.core.commitTasks
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray

/** What the Ramble screen is doing. Recording holds the live recorder; the rest is data. */
private sealed interface RamblePhase {
    data object Idle : RamblePhase
    data object Recording : RamblePhase
    data class Working(val status: String) : RamblePhase
    data object Review : RamblePhase
    data class Done(val created: Int) : RamblePhase
}

/**
 * Ramble on Android (A5): record a voice chunk (or type it), send it to the server's Ramble
 * endpoints, review the draft, commit once. Nothing is created before the user taps Commit:
 * the server applies the same all-or-nothing commit as the web client.
 */
@Composable
fun RambleScreen(state: AppState, today: String) {
    val context = LocalContext.current
    val app = context.app
    val scope = rememberCoroutineScope()
    val api = remember(app) { RambleApi(app.client) }

    var phase by remember { mutableStateOf<RamblePhase>(RamblePhase.Idle) }
    var transcript by remember { mutableStateOf("") }
    var draft by remember { mutableStateOf<RambleDraft?>(null) }
    var overrides by remember { mutableStateOf(mapOf<String, String?>()) }
    var error by remember { mutableStateOf<String?>(null) }
    var recorder by remember { mutableStateOf<RambleRecorder?>(null) }
    var elapsedMs by remember { mutableStateOf(0L) }

    fun fail(e: Exception) {
        error = when {
            e is ServerException && e.status == 403 ->
                "The server refused: this sign-in predates the Ramble scopes. Sign out and sign in again, then retry."
            e is ServerException && e.status == 409 ->
                "AI isn't configured on this server yet (Admin → Settings → AI)."
            e is ServerException && e.status == 429 ->
                "Too many requests or the AI budget is spent. Wait a minute and retry."
            e is ServerException -> "Server error ${e.status}${e.error?.let { ": $it" } ?: ""}."
            e is IllegalArgumentException -> e.message ?: "That input doesn't fit the limits."
            else -> "Couldn't reach the server. Changes are safe; retry when online."
        }
        phase = if (draft == null) RamblePhase.Idle else RamblePhase.Review
    }

    fun transcribeFile(file: java.io.File, seconds: Double) {
        phase = RamblePhase.Working("Transcribing…")
        scope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) { file.readBytes().also { file.delete() } }
                transcript = api.transcribe(bytes, "audio/mp4", seconds, null)
                error = null
                phase = RamblePhase.Idle
            } catch (e: Exception) {
                file.delete()
                fail(e)
            }
        }
    }

    fun stopAndTranscribe() {
        val r = recorder
        recorder = null
        if (r == null) return
        when (val done = r.stop()) {
            is Recording.Done -> transcribeFile(done.file, done.seconds)
            is Recording.Failed -> {
                error = done.reason
                phase = RamblePhase.Idle
            }
        }
    }

    fun startRecording() {
        error = null
        val r = RambleRecorder(context)
        if (!r.running) {
            error = "Couldn't start the microphone."
            return
        }
        recorder = r
        elapsedMs = 0L
        phase = RamblePhase.Recording
    }

    // Elapsed clock while recording; the recorder itself caps at 60 s.
    if (phase == RamblePhase.Recording) {
        LaunchedEffect(Unit) {
            val start = System.currentTimeMillis()
            while (true) {
                delay(250)
                elapsedMs = System.currentTimeMillis() - start
                if (elapsedMs >= 60_000) {
                    stopAndTranscribe()
                    break
                }
            }
        }
    }

    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording()
        else error = "Microphone access was denied. You can type the ramble instead."
    }

    fun onRecord() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            startRecording()
        } else {
            askPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    fun onExtract() {
        error = null
        phase = RamblePhase.Working("Extracting tasks…")
        scope.launch {
            try {
                draft = api.extract(transcript, draft?.raw ?: JsonArray(emptyList()))
                overrides = emptyMap()
                phase = RamblePhase.Review
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    fun onCommit() {
        val d = draft ?: return
        error = null
        phase = RamblePhase.Working("Creating tasks…")
        scope.launch {
            try {
                val created = api.commit(commitTasks(d.raw, overrides))
                draft = null
                overrides = emptyMap()
                app.syncNow()
                phase = RamblePhase.Done(created.size)
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }

        when (val p = phase) {
            is RamblePhase.Recording -> {
                Text("Recording… %ds / 60s".format((elapsedMs / 1000).toInt()), style = MaterialTheme.typography.headlineSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = { stopAndTranscribe() }) { Text("Stop") }
                    OutlinedButton(onClick = {
                        recorder?.cancel()
                        recorder = null
                        phase = RamblePhase.Idle
                    }) { Text("Cancel") }
                }
            }
            is RamblePhase.Working -> Text(p.status, style = MaterialTheme.typography.bodyLarge)
            is RamblePhase.Done -> {
                Text("Created ${p.created} task${if (p.created == 1) "" else "s"}. They sync down with everything else.", style = MaterialTheme.typography.bodyLarge)
                Button(onClick = {
                    transcript = ""
                    phase = RamblePhase.Idle
                }) { Text("Ramble again") }
            }
            else -> {
                OutlinedTextField(
                    value = transcript,
                    onValueChange = { transcript = it.take(20_000) },
                    label = { Text("What needs doing?") },
                    placeholder = { Text("Record below, or type it: Call Ana tomorrow 3pm, buy milk…") },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(
                        onClick = { onRecord() },
                        modifier = Modifier.semantics { contentDescription = "Record a voice ramble" },
                    ) {
                        Icon(Icons.Filled.Mic, contentDescription = null)
                        Text(" Record")
                    }
                    OutlinedButton(enabled = transcript.isNotBlank(), onClick = { onExtract() }) { Text("Extract tasks") }
                }
                if (phase == RamblePhase.Review && draft != null) {
                    ReviewList(state, today, draft!!, overrides, { ref, projectId ->
                        overrides = if (projectId == null) overrides - ref else overrides + (ref to projectId)
                    }, { onCommit() })
                }
            }
        }
    }
}

/** The review sheet: each draft task with what it resolves to, then one Commit. */
@Composable
private fun ReviewList(
    state: AppState,
    today: String,
    draft: RambleDraft,
    overrides: Map<String, String?>,
    onProject: (String, String?) -> Unit,
    onCommit: () -> Unit,
) {
    val prefs = state.prefs()
    Text("Review (${draft.tasks.size}) — nothing is created until you commit.", style = MaterialTheme.typography.titleSmall)
    for (task in draft.tasks) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(task.content, style = MaterialTheme.typography.bodyLarge)
                val res = task.resolution
                val projectName = when {
                    overrides.containsKey(task.ref) && overrides.getValue(task.ref) != null ->
                        state.projects[overrides.getValue(task.ref)]?.name ?: "Project"
                    res?.projectId != null -> state.projects[res.projectId]?.name ?: "Project"
                    task.project != null -> "#${task.project}"
                    else -> "Inbox"
                }
                val meta = buildList {
                    add(projectName)
                    res?.due?.let { add(Dates.dueLabel(it, today, prefs)) }
                    task.priority?.let { add("P$it") }
                    addAll(task.labels.map { "@$it" })
                }
                Text(meta.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
                if (res != null && res.issues.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (issue in res.issues) AssistChip(onClick = {}, label = { Text(issueText(issue)) })
                    }
                }
                ProjectPicker(state, task.ref, projectName, { onProject(task.ref, it) })
            }
        }
    }
    if (draft.tasks.isEmpty()) {
        Text("The model found no tasks in that text. Try rewording it.", style = MaterialTheme.typography.bodyMedium)
    } else {
        Button(enabled = draft.tasks.isNotEmpty(), onClick = onCommit) { Text("Commit ${draft.tasks.size} tasks") }
    }
}

/** Which project a reviewed task lands in: as said, or an explicit override. */
@Composable
private fun ProjectPicker(state: AppState, ref: String, current: String, onPick: (String?) -> Unit) {
    var open by remember(ref) { mutableStateOf(false) }
    TextButton(onClick = { open = true }) { Text(current) }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(text = { Text("As said") }, onClick = {
            onPick(null)
            open = false
        })
        val writable = state.projects.values.filter { !it.isArchived && it.writable }.sortedBy { it.name }
        for (project in writable) {
            DropdownMenuItem(text = { Text(if (project.isInbox) "Inbox" else project.name) }, onClick = {
                onPick(project.id)
                open = false
            })
        }
    }
}

private fun issueText(issue: String): String = when (issue) {
    "unknown_project" -> "Unknown project → Inbox"
    "unknown_section" -> "Unknown section"
    "unknown_assignee" -> "Unknown person"
    "unparsed_due" -> "Date not understood"
    "new_label" -> "New label"
    else -> issue
}

private fun AppState.prefs() = user?.prefs ?: com.bokyapps.bokydo.core.Prefs("monday", "24h", "dmy", true)

/** The mic entry in the app bar, next to the screen title. */
@Composable
fun RambleAction(onOpen: () -> Unit) {
    IconButton(onClick = onOpen, modifier = Modifier.semantics { contentDescription = "Ramble: turn voice into tasks" }) {
        Icon(Icons.Filled.Mic, contentDescription = null)
    }
}
