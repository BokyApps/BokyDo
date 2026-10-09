package com.bokyapps.bokydo

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.Dates
import com.bokyapps.bokydo.core.QuickAdd
import com.bokyapps.bokydo.core.Task
import com.bokyapps.bokydo.core.Views
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate

/** Where the user is. Kept as a small back stack: no navigation library needed for these few. */
sealed interface Route {
    data object Inbox : Route
    data object Today : Route
    data object Upcoming : Route
    data object Browse : Route
    data class Project(val id: String) : Route
    data class TaskDetail(val id: String) : Route
    data object Settings : Route
}

/** The signed-in app: task lists, quick add, browse and settings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppShell() {
    val app = LocalContext.current.app
    val version by app.store.version.collectAsState()
    // Decoding reads SQLite and parses JSON: off the main thread, showing the last state meanwhile.
    val state by produceState(app.lastState, version) { value = withContext(Dispatchers.Default) { app.appState() } }
    // "Today" moves at midnight even when nothing syncs.
    var clock by remember { mutableStateOf(0L) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000)
            clock++
        }
    }
    var stack by remember { mutableStateOf(listOf<Route>(Route.Today)) }
    var adding by remember { mutableStateOf(false) }
    val route = stack.last()
    val today = remember(state.user?.timeZone, clock) { QuickAdd.localNow(state.user?.timeZone ?: "UTC").first }

    fun go(r: Route, root: Boolean = false) {
        stack = if (root) listOf(r) else stack + r
    }
    BackHandler(enabled = stack.size > 1) { stack = stack.dropLast(1) }

    val title = when (route) {
        Route.Inbox -> "Inbox"
        Route.Today -> "Today"
        Route.Upcoming -> "Upcoming"
        Route.Browse -> "Browse"
        Route.Settings -> "Settings"
        is Route.Project -> state.projects[route.id]?.name ?: "Project"
        is Route.TaskDetail -> state.tasks[route.id]?.content?.take(30) ?: "Task"
    }
    val defaults = when (route) {
        is Route.Project -> route.id
        else -> state.user?.inboxProjectId
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (stack.size > 1) {
                        IconButton(onClick = { stack = stack.dropLast(1) }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                val root = stack.first()
                NavigationBarItem(root == Route.Inbox, { go(Route.Inbox, true) }, { Icon(Icons.Filled.Email, null) }, label = { Text("Inbox") })
                NavigationBarItem(root == Route.Today, { go(Route.Today, true) }, { Icon(Icons.Filled.Star, null) }, label = { Text("Today") })
                NavigationBarItem(root == Route.Upcoming, { go(Route.Upcoming, true) }, { Icon(Icons.Filled.DateRange, null) }, label = { Text("Upcoming") })
                NavigationBarItem(root == Route.Browse, { go(Route.Browse, true) }, { Icon(Icons.Filled.Menu, null) }, label = { Text("Browse") })
            }
        },
        floatingActionButton = {
            if (route != Route.Settings && route !is Route.TaskDetail && defaults != null) {
                FloatingActionButton(onClick = { adding = true }) { Icon(Icons.Filled.Add, contentDescription = "Add task") }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (route) {
                Route.Inbox -> state.user?.let { ProjectList(state, it.inboxProjectId, today) { go(Route.TaskDetail(it)) } }
                Route.Today -> TodayList(state, today) { go(Route.TaskDetail(it)) }
                Route.Upcoming -> UpcomingList(state, today) { go(Route.TaskDetail(it)) }
                Route.Browse -> BrowseList(state) { go(it) }
                is Route.Project -> ProjectList(state, route.id, today) { go(Route.TaskDetail(it)) }
                is Route.TaskDetail -> TaskDetailScreen(state, route.id, today, { go(Route.TaskDetail(it)) }, { stack = stack.dropLast(1) })
                Route.Settings -> SettingsScreen()
            }
        }
    }

    if (adding && defaults != null) {
        ModalBottomSheet(onDismissRequest = { adding = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            QuickAddSheet(state, defaults, today)
        }
    }
}

@Composable
private fun TodayList(state: AppState, today: String, onOpen: (String) -> Unit) {
    val lists = remember(state, today) { Views.today(state, today) }
    if (lists.overdue.isEmpty() && lists.today.isEmpty()) return Empty("Nothing due today. Enjoy your day.")
    LazyColumn(contentPadding = PaddingValues(bottom = 88.dp)) {
        group("Overdue", lists.overdue, state, today, showProject = true, onOpen = onOpen)
        group(Dates.describe(today, null, today, state.prefs()).label, lists.today, state, today, showProject = true, onOpen = onOpen)
    }
}

@Composable
private fun UpcomingList(state: AppState, today: String, onOpen: (String) -> Unit) {
    val days = remember(state, today) {
        val end = LocalDate.parse(today).plusDays(13).toString()
        Views.upcoming(state, LocalDate.parse(today).plusDays(1).toString(), end)
    }
    val overdue = remember(state, today) { Views.today(state, today).overdue }
    if (days.isEmpty() && overdue.isEmpty()) return Empty("Nothing scheduled for the next two weeks.")
    LazyColumn(contentPadding = PaddingValues(bottom = 88.dp)) {
        group("Overdue", overdue, state, today, showProject = true, onOpen = onOpen)
        for ((day, tasks) in days) group(Dates.describe(day, null, today, state.prefs()).label, tasks, state, today, showProject = true, onOpen = onOpen)
    }
}

@Composable
private fun ProjectList(state: AppState, projectId: String, today: String, onOpen: (String) -> Unit) {
    val groups = remember(state, projectId) { Views.projectTasks(state, projectId) }
    if (groups.all { it.second.isEmpty() } && groups.size == 1) return Empty("No tasks here yet. Tap + to add one.")
    LazyColumn(contentPadding = PaddingValues(bottom = 88.dp)) {
        for ((section, tasks) in groups) {
            if (section == null && tasks.isEmpty()) continue
            group(section?.name ?: "", tasks, state, today, showProject = false, showEmpty = section != null, onOpen = onOpen)
        }
    }
}

@Composable
private fun BrowseList(state: AppState, open: (Route) -> Unit) {
    val tree = remember(state) { Views.projectTree(state) }
    LazyColumn {
        item { Header("Projects") }
        items(tree, key = { it.first.id }) { (project, depth) ->
            Row(
                Modifier.fillMaxWidth().clickable { open(Route.Project(project.id)) }
                    .padding(start = (16 + depth * 20).dp, end = 16.dp, top = 14.dp, bottom = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("●", color = projectColor(project.color), modifier = Modifier.width(24.dp))
                Text(project.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (tree.isEmpty()) item { Text("No projects yet.", Modifier.padding(16.dp)) }
        item { HorizontalDivider() }
        item {
            Text("Settings", Modifier.fillMaxWidth().clickable { open(Route.Settings) }.padding(16.dp))
        }
    }
}

private fun LazyListScope.group(
    title: String,
    tasks: List<Task>,
    state: AppState,
    today: String,
    showProject: Boolean,
    showEmpty: Boolean = false,
    onOpen: (String) -> Unit,
) {
    if (tasks.isEmpty() && !showEmpty) return
    if (title.isNotEmpty()) item(key = "h:$title") { Header(title) }
    items(tasks, key = { it.id }) { TaskRow(it, state, today, showProject, onOpen) }
}

@Composable
private fun Header(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, top = 20.dp, bottom = 6.dp).semantics { heading() },
    )
}

@Composable
private fun Empty(text: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun TaskRow(task: Task, state: AppState, today: String, showProject: Boolean, onOpen: (String) -> Unit) {
    val app = LocalContext.current.app
    val prefs = state.prefs()
    val subtasks = remember(state, task.id) { Views.children(state, task.id) }
    Row(
        Modifier.fillMaxWidth().clickable { onOpen(task.id) }.padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Checkbox(
            checked = task.isCompleted,
            onCheckedChange = { done ->
                app.send(if (done) "task_complete" else "task_uncomplete", task.id)
            },
            colors = CheckboxDefaults.colors(uncheckedColor = priorityColor(task.priority)),
            modifier = Modifier.semantics {
                contentDescription = (if (task.isCompleted) "Reopen " else "Complete ") + task.content
            },
        )
        Column(Modifier.weight(1f).padding(top = 12.dp, end = 12.dp, bottom = 8.dp)) {
            Text(
                task.content,
                textDecoration = if (task.isCompleted) TextDecoration.LineThrough else null,
                style = MaterialTheme.typography.bodyLarge,
            )
            val meta = buildList {
                task.due?.let {
                    val d = Dates.describe(it.date, it.time, today, prefs)
                    add((if (it.recurring) "↻ " else "") + Dates.dueLabel(it, today, prefs) to toneColor(d.tone))
                }
                if (subtasks.isNotEmpty()) add("${subtasks.count { it.isCompleted }}/${subtasks.size}" to null)
                for (l in task.labels) add("@$l" to null)
                if (showProject) state.projects[task.projectId]?.let { add((if (it.isInbox) "Inbox" else it.name) to null) }
            }
            if (meta.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for ((text, color) in meta) {
                        Text(text, style = MaterialTheme.typography.bodySmall, color = color ?: MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                }
            }
        }
    }
}

/**
 * Task detail (A2 slice 2): read + edit the fields slice 1 could only show in a row.
 * Edits send `task_update` (content ≤ 1000, description ≤ 16000, priority 1-4 — the
 * server re-checks); complete/reopen and delete reuse the list commands so the change
 * shows at once via `Optimistic` and syncs in the background. Due/labels/project moves
 * stay read-only here until the picker slices land.
 */
@Composable
private fun TaskDetailScreen(state: AppState, taskId: String, today: String, onOpen: (String) -> Unit, onBack: () -> Unit) {
    val app = LocalContext.current.app
    val scope = rememberCoroutineScope()
    val task = state.tasks[taskId]
    if (task == null) {
        Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("This task isn't here any more. It may have been deleted or moved to an archived project.")
            Button(onClick = onBack) { Text("Back") }
        }
        return
    }
    val project = state.projects[task.projectId]
    val writable = project?.writable ?: false
    val prefs = state.prefs()
    val subtasks = remember(state, task.id) { Views.children(state, task.id) }
    val parent = task.parentId?.let { state.tasks[it] }

    var content by remember(task.id, task.content) { mutableStateOf(task.content) }
    var description by remember(task.id, task.description) { mutableStateOf(task.description) }
    var priority by remember(task.id, task.priority) { mutableStateOf(task.priority) }
    var confirmDelete by remember { mutableStateOf(false) }
    var savedNote by remember { mutableStateOf<String?>(null) }
    val dirty = content.trim() != task.content || description != task.description || priority != task.priority
    val contentOk = content.trim().isNotBlank() && content.trim().length <= 1000 && description.length <= 16000

    fun save() {
        if (!writable || !dirty || !contentOk) return
        scope.launch {
            val args = buildJsonObject {
                put("id", task.id)
                if (content.trim() != task.content) put("content", content.trim())
                if (description != task.description) put("description", description)
                if (priority != task.priority) put("priority", priority)
            }
            app.sendAll(listOf("task_update" to args))
            savedNote = "Saved. Syncing…"
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        parent?.let {
            AssistChip(onClick = { onOpen(it.id) }, label = { Text("Above: ${it.content.take(60)}") })
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(
                checked = task.isCompleted,
                onCheckedChange = { done -> app.send(if (done) "task_complete" else "task_uncomplete", task.id) },
                modifier = Modifier.semantics { contentDescription = (if (task.isCompleted) "Reopen " else "Complete ") + task.content },
            )
            Text(
                if (task.isCompleted) "Completed" else "Open",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.weight(1f))
            project?.let { Text(if (it.isInbox) "Inbox" else it.name, style = MaterialTheme.typography.bodySmall) }
        }
        OutlinedTextField(
            value = content,
            onValueChange = { content = it.take(1000); savedNote = null },
            label = { Text("Task name") },
            enabled = writable && !task.isCompleted,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = description,
            onValueChange = { description = it.take(16000); savedNote = null },
            label = { Text("Description") },
            enabled = writable && !task.isCompleted,
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Priority", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(end = 4.dp))
            for (p in 1..4) {
                if (p == priority) {
                    Button(enabled = writable, onClick = { priority = p; savedNote = null }) { Text("P$p") }
                } else {
                    androidx.compose.material3.OutlinedButton(enabled = writable, onClick = { priority = p; savedNote = null }) { Text("P$p") }
                }
            }
        }
        task.due?.let {
            Text(
                (if (it.recurring) "↻ " else "") + Dates.dueLabel(it, today, prefs),
                style = MaterialTheme.typography.bodyMedium,
                color = toneColor(Dates.describe(it.date, it.time, today, prefs).tone),
            )
        }
        if (task.labels.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (l in task.labels) AssistChip(onClick = {}, label = { Text("@$l") })
            }
        }
        if (!writable) {
            Text("Read-only: you can view this project but not change it.", style = MaterialTheme.typography.bodySmall)
        }
        savedNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(enabled = writable && dirty && contentOk, onClick = { save() }) { Text("Save") }
            androidx.compose.material3.OutlinedButton(
                enabled = writable,
                onClick = { confirmDelete = true },
            ) { Text("Delete") }
        }
        if (subtasks.isNotEmpty()) {
            Text("Sub-tasks (${subtasks.count { it.isCompleted }}/${subtasks.size})", style = MaterialTheme.typography.titleSmall)
            for (sub in subtasks) TaskRow(sub, state, today, showProject = false, onOpen = onOpen)
        } else if (task.parentId == null) {
            Text("No sub-tasks. Add one from quick add with this task open? (Sub-task creation lands with the board slice.)", style = MaterialTheme.typography.bodySmall)
        }
    }

    if (confirmDelete) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete this task?") },
            text = { Text("“${task.content.take(80)}” and its ${subtasks.size} sub-task(s) will be deleted on all devices.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    app.send("task_delete", task.id)
                    onBack()
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

/**
 * Quick add: type "Call Ana tomorrow 3pm #Work p1 @phone"; recognised parts are highlighted and
 * listed below, and tapping one keeps it as plain text instead. Parsed by the web's own parser
 * in the JavaScript sandbox; where that isn't available, the text is added as it is.
 */
@Composable
private fun QuickAddSheet(state: AppState, defaultProjectId: String, today: String) {
    val app = LocalContext.current.app
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var disabled by remember { mutableStateOf(setOf<String>()) }
    var parsed by remember { mutableStateOf(QuickAdd.Parsed.plain("")) }
    var parsedFor by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    val prefs = state.prefs()

    LaunchedEffect(text, disabled) {
        if (text.isBlank()) {
            parsed = QuickAdd.Parsed.plain("")
            parsedFor = text
            return@LaunchedEffect
        }
        delay(40)
        val now = QuickAdd.localNow(state.user?.timeZone ?: "UTC")
        val json = app.quickAddParser.parse(QuickAdd.input(text, state, defaultProjectId, now, disabled))
        parsed = json?.let { QuickAdd.parseResult(it, text) } ?: QuickAdd.Parsed.plain(text)
        parsedFor = text
    }
    LaunchedEffect(Unit) { focus.requestFocus() }

    fun submit() {
        // Parse once more if the last keystroke hasn't been parsed yet.
        scope.launch {
            val current = if (parsedFor == text) parsed else {
                val now = QuickAdd.localNow(state.user?.timeZone ?: "UTC")
                app.quickAddParser.parse(QuickAdd.input(text, state, defaultProjectId, now, disabled))
                    ?.let { QuickAdd.parseResult(it, text) } ?: QuickAdd.Parsed.plain(text)
            }
            val commands = QuickAdd.commands(text, current, defaultProjectId, null, today, prefs)
            if (commands.isEmpty()) return@launch
            app.sendAll(commands)
            note = "Added “${current.content.ifBlank { text.trim() }}”"
            text = ""
            disabled = emptySet()
        }
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        val highlight = MaterialTheme.colorScheme.primary
        OutlinedTextField(
            value = text,
            onValueChange = { text = it.take(2000) },
            label = { Text("Task name") },
            placeholder = { Text("e.g. Call Ana tomorrow 3pm #Work p1") },
            visualTransformation = TokenHighlight(if (parsedFor == text) parsed.tokens else emptyList(), highlight),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth().focusRequester(focus),
        )
        val chips = chipsFor(parsed, state, today)
        if (chips.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((label, keys) in chips) {
                    AssistChip(
                        onClick = { disabled = disabled + keys },
                        label = { Text(label) },
                        modifier = Modifier.semantics { contentDescription = "$label. Tap to keep as text" },
                    )
                }
            }
        }
        if (!app.quickAddParser.available) {
            Text(
                "Smart parsing needs an up-to-date Android System WebView; the text is added as typed.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            val project = state.projects[parsed.projectId ?: defaultProjectId]
            Text(
                project?.let { if (it.isInbox) "Inbox" else it.name } ?: "",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.size(8.dp))
            Button(enabled = text.isNotBlank(), onClick = { submit() }) { Text("Add task") }
        }
    }
}

/** What quick add recognised, one chip per token kind; tapping one keeps those tokens as text. */
private fun chipsFor(p: QuickAdd.Parsed, state: AppState, today: String): List<Pair<String, List<String>>> {
    val prefs = state.prefs()
    fun keys(kind: String) = p.tokens.filter { it.kind == kind }.map(QuickAdd::tokenKey)
    return buildList {
        p.due?.let { due ->
            val date = (due["date"] as? kotlinx.serialization.json.JsonPrimitive)?.content
            val time = (due["time"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
            val recurring = due["recurrence"].let { it != null && it !is kotlinx.serialization.json.JsonNull }
            val label = if (recurring) (due["string"] as? kotlinx.serialization.json.JsonPrimitive)?.content
            else date?.let { Dates.describe(it, time, today, prefs).label }
            label?.let { add((if (recurring) "↻ $it" else it) to keys("due")) }
        }
        p.projectId?.let { id -> state.projects[id]?.let { add("#${if (it.isInbox) "Inbox" else it.name}" to keys("project")) } }
        p.sectionId?.let { id -> state.sections[id]?.let { add("/${it.name}" to keys("section")) } }
        p.priority?.let { add("P$it" to keys("priority")) }
        for (l in p.labels) add("@$l" to keys("label").filter { it.endsWith(l.lowercase()) }.ifEmpty { keys("label") })
        p.assigneeId?.let { id -> state.people[id]?.let { add("+${it.username}" to keys("assignee")) } }
        p.deadline?.let { add("Deadline ${Dates.describe(it, null, today, prefs).label}" to keys("deadline")) }
        p.durationMinutes?.let { add("${it} min" to keys("duration")) }
        if (p.reminders.isNotEmpty()) add("${p.reminders.size} reminder${if (p.reminders.size > 1) "s" else ""}" to keys("reminder"))
    }
}

/** Highlights recognised tokens in the text field; ranges that no longer match are ignored. */
private class TokenHighlight(private val tokens: List<QuickAdd.Highlight>, private val color: Color) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val styled = buildAnnotatedString {
            append(text.text)
            for (t in tokens) {
                if (t.end <= text.length && text.text.substring(t.start, t.end) == t.text) {
                    addStyle(SpanStyle(color = color, fontWeight = FontWeight.SemiBold), t.start, t.end)
                }
            }
        }
        return TransformedText(styled, OffsetMapping.Identity)
    }

    override fun equals(other: Any?) = other is TokenHighlight && other.tokens == tokens && other.color == color
    override fun hashCode() = tokens.hashCode() * 31 + color.hashCode()
}

private fun AppState.prefs() = user?.prefs ?: com.bokyapps.bokydo.core.Prefs("monday", "24h", "dmy", true)

@Composable
private fun priorityColor(p: Int): Color = when (p) {
    1 -> Color(0xFFD1453B)
    2 -> Color(0xFFEB8909)
    3 -> Color(0xFF246FE0)
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun toneColor(t: Dates.Tone): Color = when (t) {
    Dates.Tone.OVERDUE -> Color(0xFFD1453B)
    Dates.Tone.TODAY -> Color(0xFF058527)
    Dates.Tone.TOMORROW -> Color(0xFFAD6200)
    Dates.Tone.WEEK -> Color(0xFF692FC2)
    Dates.Tone.LATER -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** The web's project colours (a subset; the full theme engine arrives with A2's themes). */
private fun projectColor(name: String): Color = when (name) {
    "berry_red" -> Color(0xFFB8256F)
    "red" -> Color(0xFFDB4035)
    "orange" -> Color(0xFFFF9933)
    "yellow" -> Color(0xFFFAD000)
    "olive_green" -> Color(0xFFAFB83B)
    "lime_green" -> Color(0xFF7ECC49)
    "green" -> Color(0xFF299438)
    "mint_green" -> Color(0xFF6ACCBC)
    "teal" -> Color(0xFF158FAD)
    "sky_blue" -> Color(0xFF14AAF5)
    "light_blue" -> Color(0xFF96C3EB)
    "blue" -> Color(0xFF4073FF)
    "grape" -> Color(0xFF884DFF)
    "violet" -> Color(0xFFAF38EB)
    "lavender" -> Color(0xFFEB96EB)
    "magenta" -> Color(0xFFE05194)
    "salmon" -> Color(0xFFFF8D85)
    "taupe" -> Color(0xFFCCAC93)
    else -> Color(0xFF808080)
}
