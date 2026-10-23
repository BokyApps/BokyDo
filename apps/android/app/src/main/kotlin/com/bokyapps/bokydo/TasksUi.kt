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
import androidx.compose.material.icons.automirrored.filled.ViewList
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.ViewWeek
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
import com.bokyapps.bokydo.core.TimeZones
import com.bokyapps.bokydo.core.Views
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.time.LocalDate

/** Where the user is. Kept as a small back stack: no navigation library needed for these few. */
sealed interface Route {
    data object Inbox : Route
    data object Today : Route
    data object Upcoming : Route
    data object Browse : Route
    data class Project(val id: String) : Route
    data class Board(val id: String) : Route
    data class TaskDetail(val id: String) : Route
    data object Ramble : Route
    data object Settings : Route
    data object TimeZone : Route
    data object Search : Route
    data object Labels : Route
    data class Label(val name: String) : Route
    data object Filters : Route
    data class Filter(val id: String) : Route
}

/** The signed-in app: task lists, quick add, browse and settings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppShell(state: AppState) {
    val app = LocalContext.current.app
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
    // The user's own zone wins, then the account's, then the phone's.
    val zone = state.user?.prefs?.timezone ?: state.user?.timeZone ?: TimeZones.detect() ?: "UTC"
    val today = remember(zone, clock) { QuickAdd.localNow(zone).first }

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
        Route.TimeZone -> "Time zone"
        Route.Ramble -> "Ramble"
        is Route.Project -> state.projects[route.id]?.name ?: "Project"
        is Route.Board -> state.projects[route.id]?.name ?: "Board"
        is Route.TaskDetail -> state.tasks[route.id]?.content?.take(30) ?: "Task"
        Route.Search -> "Search"
        Route.Labels -> "Labels"
        is Route.Label -> "@${route.name}"
        Route.Filters -> "Filters"
        is Route.Filter -> state.filters[route.id]?.name ?: "Filter"
    }
    val defaults = when (route) {
        is Route.Project -> route.id
        is Route.Board -> route.id
        else -> state.user?.inboxProjectId
    }
    // A task added from a label view carries that label.
    val defaultLabels = when (route) {
        is Route.Label -> listOf(route.name)
        else -> emptyList()
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
                actions = {
                    // List and board are two views of the same project.
                    val projectId = when (route) {
                        is Route.Project -> route.id
                        is Route.Board -> route.id
                        else -> null
                    }
                    if (projectId != null) {
                        IconButton(onClick = {
                            stack = stack.dropLast(1) + if (route is Route.Board) {
                                Route.Project(projectId)
                            } else {
                                Route.Board(projectId)
                            }
                        }) {
                            Icon(
                                if (route is Route.Board) Icons.AutoMirrored.Filled.ViewList else Icons.Filled.ViewWeek,
                                contentDescription = if (route is Route.Board) "List view" else "Board view",
                            )
                        }
                    }
                    if (route != Route.Search) {
                        IconButton(onClick = { go(Route.Search) }) {
                            Icon(Icons.Filled.Search, contentDescription = "Search")
                        }
                    }
                    if (route != Route.Ramble) RambleAction { go(Route.Ramble) }
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
            if (route != Route.Settings && route !is Route.TaskDetail && route != Route.Ramble &&
                route != Route.Search && route != Route.Labels && route != Route.Filters && defaults != null
            ) {
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
                is Route.Board -> BoardView(state, route.id, today) { go(Route.TaskDetail(it)) }
                is Route.TaskDetail -> TaskDetailScreen(state, route.id, today, { go(Route.TaskDetail(it)) }, { stack = stack.dropLast(1) })
                Route.Ramble -> RambleScreen(state, today)
                Route.Settings -> SettingsScreen(state) { go(Route.TimeZone) }
                Route.TimeZone -> TimeZoneScreen(
                    current = state.user?.prefs?.timezone ?: state.user?.timeZone,
                    onPick = { zone ->
                        app.sendAll(listOf("user_update_preferences" to buildJsonObject { put("timezone", zone) }))
                        stack = stack.dropLast(1)
                    },
                    onBack = { stack = stack.dropLast(1) },
                )
                Route.Search -> SearchScreen(state, today, { go(Route.TaskDetail(it)) }, { go(Route.Project(it)) })
                Route.Labels -> LabelsScreen(state) { go(Route.Label(it)) }
                is Route.Label -> LabelScreen(state, route.name, today) { go(Route.TaskDetail(it)) }
                Route.Filters -> FiltersScreen(state) { go(Route.Filter(it)) }
                is Route.Filter -> FilterScreen(state, state.filters[route.id], today) { go(Route.TaskDetail(it)) }
            }
        }
    }

    if (adding && defaults != null) {
        ModalBottomSheet(onDismissRequest = { adding = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            QuickAddSheet(state, defaults, today, defaultLabels)
        }
    }

    // The travel prompt: the phone's zone differs from the saved one (offered once per zone).
    var travel by remember { mutableStateOf<com.bokyapps.bokydo.core.ZoneOption?>(null) }
    LaunchedEffect(zone, state.user?.prefs?.timezone) {
        val detected = TimeZones.detect() ?: return@LaunchedEffect
        val saved = state.user?.prefs?.timezone ?: state.user?.timeZone ?: return@LaunchedEffect
        if (detected == saved) return@LaunchedEffect
        if (app.device.lastOfferedZone == detected) return@LaunchedEffect
        travel = TimeZones.describe(detected)
        app.device.lastOfferedZone = detected
    }
    travel?.let { zone ->
        TravelPrompt(
            zone = zone,
            onSwitch = {
                travel = null
                app.sendAll(listOf("user_update_preferences" to buildJsonObject { put("timezone", zone.id) }))
            },
            onDismiss = { travel = null },
        )
    }
}

@Composable
private fun TodayList(state: AppState, today: String, onOpen: (String) -> Unit) {
    val lists = remember(state, today) { Views.today(state, today) }
    if (lists.overdue.isEmpty() && lists.today.isEmpty()) return Empty("Nothing due today. Enjoy your day.")
    LazyColumn(contentPadding = PaddingValues(bottom = if (LocalCompact.current) 64.dp else 88.dp)) {
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
    LazyColumn(contentPadding = PaddingValues(bottom = if (LocalCompact.current) 64.dp else 88.dp)) {
        group("Overdue", overdue, state, today, showProject = true, onOpen = onOpen)
        for ((day, tasks) in days) group(Dates.describe(day, null, today, state.prefs()).label, tasks, state, today, showProject = true, onOpen = onOpen)
    }
}

@Composable
private fun ProjectList(state: AppState, projectId: String, today: String, onOpen: (String) -> Unit) {
    val groups = remember(state, projectId) { Views.projectTasks(state, projectId) }
    if (groups.all { it.second.isEmpty() } && groups.size == 1) return Empty("No tasks here yet. Tap + to add one.")
    LazyColumn(contentPadding = PaddingValues(bottom = if (LocalCompact.current) 64.dp else 88.dp)) {
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
            Text("Filters", Modifier.fillMaxWidth().clickable { open(Route.Filters) }.padding(16.dp))
        }
        item {
            Text("Labels", Modifier.fillMaxWidth().clickable { open(Route.Labels) }.padding(16.dp))
        }
        item {
            Text("Search", Modifier.fillMaxWidth().clickable { open(Route.Search) }.padding(16.dp))
        }
        item { HorizontalDivider() }
        item {
            Text("Ramble (voice → tasks)", Modifier.fillMaxWidth().clickable { open(Route.Ramble) }.padding(16.dp))
        }
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
fun Header(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, top = 20.dp, bottom = 6.dp).semantics { heading() },
    )
}

@Composable
fun Empty(text: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun TaskRow(task: Task, state: AppState, today: String, showProject: Boolean, onOpen: (String) -> Unit) {
    val app = LocalContext.current.app
    val prefs = state.prefs()
    val subtasks = remember(state, task.id) { Views.children(state, task.id) }
    val compact = LocalCompact.current
    Row(
        Modifier.fillMaxWidth().clickable { onOpen(task.id) }
            .padding(horizontal = 4.dp, vertical = if (compact) 0.dp else 2.dp),
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
        Column(
            Modifier.weight(1f).padding(
                top = if (compact) 8.dp else 12.dp,
                end = 12.dp,
                bottom = if (compact) 4.dp else 8.dp,
            ),
        ) {
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
    var editingLabels by remember { mutableStateOf(false) }
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

    /**
     * Take a label off the task; the change shows at once and goes to the server with the rest.
     */
    fun setLabels(labels: List<String>) {
        if (!writable) return
        app.sendAll(
            listOf(
                "task_update" to buildJsonObject {
                    put("id", task.id)
                    putJsonArray("labels") { labels.forEach { add(JsonPrimitive(it)) } }
                },
            ),
        )
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
        if (task.labels.isNotEmpty() || writable) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (l in task.labels) {
                    AssistChip(onClick = { editingLabels = true }, label = { Text("@$l") })
                }
                if (writable) {
                    AssistChip(onClick = { editingLabels = true }, label = { Text("+ Label") })
                }
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
        HorizontalDivider()
        CommentsSection(state, task.id, writable && !(project?.isArchived ?: false))
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

    if (editingLabels) {
        TaskLabelsDialog(
            state = state,
            task = task,
            onDismiss = { editingLabels = false },
            onSave = { labels ->
                setLabels(labels)
                editingLabels = false
            },
        )
    }
}

/**
 * The labels of a task: the user's own labels to tick, and a field for a new one. The server's
 * rules apply: no spaces, @ or #, and one label per name.
 */
@Composable
private fun TaskLabelsDialog(state: AppState, task: Task, onDismiss: () -> Unit, onSave: (List<String>) -> Unit) {
    var chosen by remember(task.id) { mutableStateOf(task.labels.toList()) }
    var fresh by remember(task.id) { mutableStateOf("") }
    val known = remember(state, task.id) {
        (state.labels.values.map { it.name } + task.labels).distinctBy { it.lowercase() }.sortedBy { it.lowercase() }
    }
    val name = fresh.trim()
    val valid = name.isNotEmpty() && !name.any { it.isWhitespace() || it == '@' || it == '#' }
    val already = chosen.any { it.equals(name, ignoreCase = true) }

    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Labels") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (l in known) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = chosen.any { it.equals(l, ignoreCase = true) },
                            onCheckedChange = { on ->
                                chosen = if (on) {
                                    chosen + l
                                } else {
                                    chosen.filterNot { it.equals(l, ignoreCase = true) }
                                }
                            },
                        )
                        Text(l)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = fresh,
                        onValueChange = { fresh = it.take(60) },
                        label = { Text("New label") },
                        singleLine = true,
                        isError = already,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(
                        enabled = valid && !already,
                        onClick = {
                            chosen = chosen + name
                            fresh = ""
                        },
                    ) { Icon(Icons.Filled.Add, contentDescription = "Add label") }
                }
                Text("No spaces, @ or #.", style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(chosen) }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * Quick add: type "Call Ana tomorrow 3pm #Work p1 @phone"; recognised parts are highlighted and
 * listed below, and tapping one keeps it as plain text instead. Parsed by the web's own parser
 * in the JavaScript sandbox; where that isn't available, the text is added as it is.
 */
@Composable
private fun QuickAddSheet(state: AppState, defaultProjectId: String, today: String, defaultLabels: List<String> = emptyList()) {
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
            val commands = QuickAdd.commands(text, current, defaultProjectId, null, today, prefs, defaultLabels)
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

fun AppState.prefs() = user?.prefs ?: com.bokyapps.bokydo.core.Prefs("monday", "24h", "dmy", true)

/** The theme's priority colours (the web's p1–p4). */
@Composable
internal fun priorityColor(p: Int): Color {
    val t = LocalThemeTokens.current
    return when (p) {
        1 -> Color(t.p1)
        2 -> Color(t.p2)
        3 -> Color(t.p3)
        else -> Color(t.p4)
    }
}

@Composable
internal fun toneColor(t: Dates.Tone): Color {
    val tokens = LocalThemeTokens.current
    return when (t) {
        Dates.Tone.OVERDUE -> Color(tokens.danger)
        Dates.Tone.TODAY -> Color(tokens.success)
        Dates.Tone.TOMORROW -> Color(tokens.warning)
        Dates.Tone.WEEK -> Color(tokens.p3)
        Dates.Tone.LATER -> Color(tokens.muted)
    }
}

/** The project and label colours, tuned per theme so they stay readable. */
@Composable
fun projectColor(name: String): Color =
    Color(LocalThemeTokens.current.project[name] ?: 0xFF808080L)
