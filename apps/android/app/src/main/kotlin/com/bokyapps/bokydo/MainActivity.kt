package com.bokyapps.bokydo

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import com.bokyapps.bokydo.core.ServerAddress
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.DateFormat
import java.util.Date

/**
 * Connect to a server, wait for the browser sign-in, then the app itself ([AppShell]). Settings
 * shows the account, sync status and notifications.
 */
class MainActivity : ComponentActivity() {
    /** The intent that opened us (launcher, share, tile, shortcut); tiles and shortcuts re-send it. */
    private val launch = mutableStateOf<Intent?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        launch.value = intent
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) {
                    val screen by app.screen.collectAsState()
                    // A new tile/shortcut/share intent restarts the shell so it opens where asked.
                    key(launch.value) {
                        when (val s = screen) {
                            is AppScreen.Connect -> ConnectScreen(s.message)
                            is AppScreen.WaitingForBrowser -> WaitingScreen(s.host)
                            AppScreen.Home -> {
                                val parsed = parseLaunch(launch.value)
                                AppShell(openQuickAdd = parsed.quickAdd, quickAddText = parsed.text, startRoute = parsed.route)
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        launch.value = intent
    }
}

/** Where a launcher, share, tile or shortcut intent wants to land. */
private data class Launch(val route: Route, val quickAdd: Boolean, val text: String)

private fun parseLaunch(intent: Intent?): Launch {
    if (intent == null) return Launch(Route.Today, false, "")
    if (intent.action == Intent.ACTION_SEND && intent.type?.startsWith("text/") == true) {
        // Shared text is untrusted: plain text, capped, still needs the user to tap Add.
        val shared = com.bokyapps.bokydo.core.sanitizeSharedText(intent.getCharSequenceExtra(Intent.EXTRA_TEXT))
        if (shared != null) return Launch(Route.Today, true, shared)
        return Launch(Route.Today, false, "")
    }
    return when (intent.action) {
        "com.bokyapps.bokydo.QUICK_ADD" -> Launch(Route.Today, true, "")
        "com.bokyapps.bokydo.SHOW_TODAY" -> Launch(Route.Today, false, "")
        else -> Launch(Route.Today, false, "")
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
fun SettingsScreen() {
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
    Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
        NotificationsSection()
    }
}

/** Notification permission, exact reminders and instant notifications (UnifiedPush). */
@Composable
private fun NotificationsSection() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var refresh by remember { mutableStateOf(0) }
    val allowed = remember(refresh) { Notifier.allowed(context) }
    val exact = remember(refresh) { ReminderAlarms.canScheduleExact(context) }
    val distributors = remember(refresh) { UnifiedPush.distributors(context) }
    val push by UnifiedPush.state.collectAsState()
    var note by remember { mutableStateOf<String?>(null) }
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh++ }
    // Coming back from system settings: look again.
    LaunchedEffect(Unit) { refresh++ }

    Text("Notifications", style = MaterialTheme.typography.titleMedium)
    if (!allowed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        Text("Allow notifications to get your reminders.")
        Button(onClick = { askPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("Allow notifications") }
    }
    if (!exact && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        Text("Reminders may arrive a few minutes late until you allow exact alarms.")
        OutlinedButton(onClick = {
            context.startActivity(
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}")),
            )
        }) { Text("Allow exact reminders") }
    }
    Text("Reminders are set on this phone and work offline.", style = MaterialTheme.typography.bodySmall)
    when (val p = push) {
        is PushState.On -> Text("Instant notifications via ${p.distributor} (${p.host}).")
        is PushState.Registering -> Text("Connecting to ${p.distributor}…")
        is PushState.HostNotAllowed -> Text(
            "This server doesn't allow ${p.host} yet. Ask its admin to add it under Admin → Settings → Push services.",
            color = MaterialTheme.colorScheme.error,
        )
        is PushState.Failed -> Text(p.reason, color = MaterialTheme.colorScheme.error)
        PushState.Off -> if (distributors.isEmpty()) {
            Text(
                "For instant assignments, mentions and comments, install a UnifiedPush app such as ntfy.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        if (push == PushState.Off || push is PushState.Failed) {
            for (d in distributors.take(3)) {
                OutlinedButton(onClick = { scope.launch { UnifiedPush.register(context, d) } }) {
                    Text("Use ${UnifiedPush.label(context, d)}")
                }
            }
        } else {
            OutlinedButton(onClick = { scope.launch { UnifiedPush.unregister(context) } }) { Text("Turn off") }
        }
        if (push is PushState.On) {
            OutlinedButton(onClick = {
                scope.launch {
                    note = runCatching { context.app.client.call("POST", "/api/v1/push/test") }
                        .fold({ "Test sent." }, { "Couldn't send a test." })
                }
            }) { Text("Test") }
        }
    }
    note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
}

private data class Summary(
    val username: String?,
    val projects: Int,
    val tasks: Int,
    val pending: Int,
    val rejected: Int,
    val syncedAt: Long?,
)
