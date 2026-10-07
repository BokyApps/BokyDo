package com.bokyapps.bokydo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.isSystemInDarkTheme
import com.bokyapps.bokydo.core.ServerAddress
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.DateFormat
import java.util.Date

/**
 * A1's screens: connect to a server, wait for the browser sign-in, and a status page that shows
 * the synced data. The real task screens come in A2.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) {
                    val screen by app.screen.collectAsState()
                    when (val s = screen) {
                        is AppScreen.Connect -> ConnectScreen(s.message)
                        is AppScreen.WaitingForBrowser -> WaitingScreen(s.host)
                        AppScreen.Home -> HomeScreen()
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectScreen(message: String?) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var input by remember { mutableStateOf("") }
    var error by remember(message) { mutableStateOf(message) }
    var busy by remember { mutableStateOf(false) }
    var confirmHttp by remember { mutableStateOf<ServerAddress?>(null) }

    fun go(address: ServerAddress) {
        busy = true
        scope.launch {
            error = context.app.startSignIn(context, address)
            busy = false
        }
    }

    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("BokyDo", style = MaterialTheme.typography.headlineMedium)
        Text("Enter the address of your BokyDo server.")
        OutlinedTextField(
            value = input,
            onValueChange = { input = it },
            label = { Text("Server address") },
            placeholder = { Text("tasks.example.com") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            enabled = !busy && input.isNotBlank(),
            onClick = {
                when (val parsed = ServerAddress.parse(input)) {
                    is ServerAddress.Result.Invalid -> error = parsed.reason
                    is ServerAddress.Result.Ok ->
                        if (parsed.address.insecure) confirmHttp = parsed.address else go(parsed.address)
                }
            },
        ) { Text(if (busy) "Checking…" else "Continue") }
    }

    confirmHttp?.let { address ->
        AlertDialog(
            onDismissRequest = { confirmHttp = null },
            title = { Text("Not encrypted") },
            text = {
                Text(
                    "${address.host} uses plain http. Anyone on the same network could read your tasks " +
                        "and your sign-in. Only continue on a network you trust.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmHttp = null
                    go(address)
                }) { Text("Continue anyway") }
            },
            dismissButton = { TextButton(onClick = { confirmHttp = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun WaitingScreen(host: String) {
    val context = LocalContext.current
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Sign in", style = MaterialTheme.typography.headlineMedium)
        Text("Finish signing in to $host in the browser. You'll come back here automatically.")
        OutlinedButton(onClick = { context.app.cancelSignIn() }) { Text("Cancel") }
    }
}

@Composable
private fun HomeScreen() {
    val context = LocalContext.current
    val app = context.app
    val scope = rememberCoroutineScope()
    val version by app.store.version.collectAsState()
    val syncError by app.syncError.collectAsState()
    // Re-read whenever the store changes.
    val summary = remember(version) {
        val user = app.store.snapshot("user") as? JsonObject
        Summary(
            username = (user?.get("username") as? JsonPrimitive)?.content,
            projects = app.store.count("projects"),
            tasks = app.store.count("tasks"),
            pending = app.store.pendingCount(),
            rejected = app.store.rejected().size,
            syncedAt = app.store.syncedAt(),
        )
    }
    val host = app.sessions.load()?.origin ?: ""
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("BokyDo", style = MaterialTheme.typography.headlineMedium)
        Text("Signed in to $host" + (summary.username?.let { " as $it" } ?: ""))
        Text("${summary.projects} projects · ${summary.tasks} tasks")
        Text(
            summary.syncedAt?.let { "Last synced " + DateFormat.getDateTimeInstance().format(Date(it)) }
                ?: "Not synced yet",
        )
        if (summary.pending > 0) Text("${summary.pending} changes waiting to be sent")
        if (summary.rejected > 0) Text("${summary.rejected} changes were refused by the server", color = MaterialTheme.colorScheme.error)
        syncError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = { scope.launch { runCatching { app.sync() } } }) { Text("Sync now") }
            OutlinedButton(onClick = { scope.launch { app.signOut() } }) { Text("Sign out") }
        }
        Text("Task lists, quick add and widgets arrive in the next releases.", style = MaterialTheme.typography.bodySmall)
    }
}

private data class Summary(
    val username: String?,
    val projects: Int,
    val tasks: Int,
    val pending: Int,
    val rejected: Int,
    val syncedAt: Long?,
)
