package com.bokyapps.bokydo

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.Comment
import com.bokyapps.bokydo.core.Dates
import com.bokyapps.bokydo.core.Filter
import com.bokyapps.bokydo.core.Filters
import com.bokyapps.bokydo.core.Ids
import com.bokyapps.bokydo.core.Label
import com.bokyapps.bokydo.core.QuickAdd
import com.bokyapps.bokydo.core.Views
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The remaining core screens (A2c): search, labels, saved filters and the comments on a task.
 * Everything is read from the synced data, so it works offline; changes are queued and shown
 * at once (`Optimistic`) until the server has them.
 */

/** Search over the synced data: open tasks first, then completed ones, plus matching projects. */
@Composable
fun SearchScreen(state: AppState, today: String, onOpenTask: (String) -> Unit, onOpenProject: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    val found = remember(state, query) { Views.search(state, query) }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it.take(200) },
            label = { Text("Search tasks and projects") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier.fillMaxWidth().padding(16.dp),
        )
        if (query.isBlank()) {
            Empty("Type to search your tasks and projects. It works offline.")
            return@Column
        }
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            if (found.projects.isNotEmpty()) {
                item { Header("Projects") }
                items(found.projects, key = { "p:" + it.id }) { project ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpenProject(project.id) }.padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("●", color = projectColor(project.color), modifier = Modifier.width(24.dp))
                        Text(project.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (found.tasks.isNotEmpty()) item { Header("Tasks") }
            items(found.tasks, key = { "t:" + it.id }) { task ->
                TaskRow(task, state, today, showProject = true, onOpen = onOpenTask)
            }
            if (found.tasks.isEmpty() && found.projects.isEmpty()) {
                item { Text("Nothing found.", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

/** The user's labels (with how many open tasks carry them) and the names used on shared tasks. */
@Composable
fun LabelsScreen(state: AppState, onOpenLabel: (String) -> Unit) {
    val app = LocalContext.current.app
    var adding by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Label?>(null) }
    var deleting by remember { mutableStateOf<Label?>(null) }
    val labels = remember(state) { state.labels.values.sortedBy { it.itemOrder } }
    val own = remember(labels) { labels.map { it.name.lowercase() }.toSet() }
    val shared = remember(state, own) { Views.allLabelNames(state).filter { it.lowercase() !in own } }

    LazyColumn(contentPadding = PaddingValues(bottom = 88.dp)) {
        item {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Labels", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                IconButton(onClick = { adding = true }) {
                    Icon(Icons.Filled.Add, contentDescription = "Add label")
                }
            }
        }
        items(labels, key = { "l:" + it.id }) { label ->
            LabelRow(
                label = label,
                count = Views.labelTasks(state, label.name).size,
                onOpen = { onOpenLabel(label.name) },
                onFavourite = {
                    app.sendAll(
                        listOf(
                            "label_update" to buildJsonObject {
                                put("id", label.id)
                                put("isFavorite", !label.isFavorite)
                            },
                        ),
                    )
                },
                onEdit = { editing = label },
                onDelete = { deleting = label },
            )
        }
        if (shared.isNotEmpty()) {
            item { Header("On shared tasks") }
            items(shared, key = { "s:" + it }) { name ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpenLabel(name) }.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("@$name", modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${Views.labelTasks(state, name).size}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        if (labels.isEmpty() && shared.isEmpty()) {
            item { Text("No labels yet. Add one here or type @name when tagging a task.", Modifier.padding(16.dp)) }
        }
    }

    if (adding || editing != null) {
        LabelDialog(label = editing, state = state, onDismiss = { adding = false; editing = null })
    }
    deleting?.let { label ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete label?") },
            text = { Text("@${label.name} will be removed from all tasks you can edit.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    app.sendAll(listOf("label_delete" to buildJsonObject { put("id", label.id) }))
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun LabelRow(
    label: Label,
    count: Int,
    onOpen: () -> Unit,
    onFavourite: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable { onOpen() }.padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("@${label.name}", modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (count > 0) Text("$count", style = MaterialTheme.typography.bodySmall)
        IconButton(onClick = onFavourite) {
            Icon(
                Icons.Filled.Star,
                contentDescription = if (label.isFavorite) "Remove from favourites" else "Add to favourites",
                tint = if (label.isFavorite) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "Edit label") }
        IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "Delete label") }
    }
}

@Composable
private fun LabelDialog(label: Label?, state: AppState, onDismiss: () -> Unit) {
    val app = LocalContext.current.app
    var name by remember(label?.id) { mutableStateOf(label?.name ?: "") }
    val trimmed = name.trim()
    val valid = trimmed.isNotEmpty() && !trimmed.any { it.isWhitespace() || it == '@' || it == '#' }
    // The server keeps one label per name, so a second one with the same name is refused.
    val taken = state.labels.values.any {
        it.id != label?.id && it.name.equals(trimmed, ignoreCase = true)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (label == null) "Add label" else "Edit label") },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(60) },
                label = { Text("Name") },
                singleLine = true,
                supportingText = { Text("No spaces, @ or #.") },
                isError = taken,
            )
        },
        confirmButton = {
            TextButton(
                enabled = valid && !taken,
                onClick = {
                    val args = buildJsonObject {
                        put("id", label?.id ?: Ids.newId())
                        put("name", trimmed)
                    }
                    app.sendAll(listOf((if (label == null) "label_add" else "label_update") to args))
                    onDismiss()
                },
            ) { Text(if (label == null) "Add" else "Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** The open tasks with one label. */
@Composable
fun LabelScreen(state: AppState, name: String, today: String, onOpenTask: (String) -> Unit) {
    val tasks = remember(state, name) { Views.labelTasks(state, name) }
    if (tasks.isEmpty()) return Empty("No open tasks with @$name")
    LazyColumn(contentPadding = PaddingValues(bottom = 88.dp)) {
        items(tasks, key = { it.id }) { TaskRow(it, state, today, showProject = true, onOpen = onOpenTask) }
    }
}

/** The saved filters, with their query. */
@Composable
fun FiltersScreen(state: AppState, onOpenFilter: (String) -> Unit) {
    val app = LocalContext.current.app
    var adding by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Filter?>(null) }
    var deleting by remember { mutableStateOf<Filter?>(null) }
    val filters = remember(state) { state.filters.values.sortedBy { it.itemOrder } }

    LazyColumn(contentPadding = PaddingValues(bottom = 88.dp)) {
        item {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Filters", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                IconButton(onClick = { adding = true }) {
                    Icon(Icons.Filled.Add, contentDescription = "Add filter")
                }
            }
        }
        items(filters, key = { "f:" + it.id }) { filter ->
            FilterRow(
                filter = filter,
                onOpen = { onOpenFilter(filter.id) },
                onFavourite = {
                    app.sendAll(
                        listOf(
                            "filter_update" to buildJsonObject {
                                put("id", filter.id)
                                put("isFavorite", !filter.isFavorite)
                            },
                        ),
                    )
                },
                onEdit = { editing = filter },
                onDelete = { deleting = filter },
            )
        }
        if (filters.isEmpty()) {
            item {
                Text(
                    "No filters yet. Add one, for example “today | overdue” or “#Work & p1”.",
                    Modifier.padding(16.dp),
                )
            }
        }
    }

    if (adding || editing != null) {
        FilterDialog(filter = editing, state = state, onDismiss = { adding = false; editing = null })
    }
    deleting?.let { filter ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete filter?") },
            text = { Text("“${filter.name}” will be deleted.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    app.sendAll(listOf("filter_delete" to buildJsonObject { put("id", filter.id) }))
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun FilterRow(
    filter: Filter,
    onOpen: () -> Unit,
    onFavourite: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable { onOpen() }.padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(filter.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(filter.query, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = onFavourite) {
            Icon(
                Icons.Filled.Star,
                contentDescription = if (filter.isFavorite) "Remove from favourites" else "Add to favourites",
                tint = if (filter.isFavorite) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "Edit filter") }
        IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "Delete filter") }
    }
}

/** Add or edit a filter: the query is checked by the engine before it is saved. */
@Composable
private fun FilterDialog(filter: Filter?, state: AppState, onDismiss: () -> Unit) {
    val app = LocalContext.current.app
    val scope = rememberCoroutineScope()
    var name by remember(filter?.id) { mutableStateOf(filter?.name ?: "") }
    var query by remember(filter?.id) { mutableStateOf(filter?.query ?: "") }
    var problem by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }

    fun save() {
        app.sendAll(
            listOf(
                (if (filter == null) "filter_add" else "filter_update") to buildJsonObject {
                    put("id", filter?.id ?: Ids.newId())
                    put("name", name.trim())
                    put("query", query.trim())
                },
            ),
        )
        onDismiss()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (filter == null) "Add filter" else "Edit filter") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(120) },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it.take(1024) },
                    label = { Text("Query") },
                    placeholder = { Text("today | overdue") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Filters use the web's syntax: today, overdue, p1, #Project, /Section, @label, " +
                        "search: text, and & | ! ( ).",
                    style = MaterialTheme.typography.bodySmall,
                )
                problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                if (checking) Text("Checking…", style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && query.isNotBlank() && !checking,
                onClick = {
                    // The server refuses a filter it can't parse, so check it here first.
                    checking = true
                    problem = null
                    scope.launch {
                        val answer = withContext(Dispatchers.Default) {
                            app.filterEngine.run(Filters.request(state, query.trim(), localNow(state)))
                        }
                        checking = false
                        if (answer == null) {
                            // No JavaScript sandbox here: the server still checks the query when
                            // it saves the filter, and says so in Settings if it refuses it.
                            save()
                            return@launch
                        }
                        when (val result = Filters.result(answer, state)) {
                            is Filters.Result.Error -> problem = result.message
                            is Filters.Result.Ok -> save()
                        }
                    }
                },
            ) { Text(if (filter == null) "Add" else "Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** One saved filter, run over the synced data. */
@Composable
fun FilterScreen(state: AppState, filter: Filter?, today: String, onOpenTask: (String) -> Unit) {
    val app = LocalContext.current.app
    var result by remember { mutableStateOf<Filters.Result?>(null) }
    var running by remember { mutableStateOf(false) }
    LaunchedEffect(filter?.id, filter?.query, state) {
        val f = filter ?: return@LaunchedEffect
        running = true
        // The request is built off the main thread: it walks every open task.
        val answer = withContext(Dispatchers.Default) {
            app.filterEngine.run(Filters.request(state, f.query, localNow(state)))
        }
        result = if (answer == null) {
            Filters.Result.Error("Filters need an up-to-date Android System WebView.")
        } else {
            Filters.result(answer, state)
        }
        running = false
    }

    if (filter == null) {
        Empty("This filter is gone. It may have been deleted on another device.")
        return
    }
    val ok = result as? Filters.Result.Ok
    LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
        item { Text(filter.query, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp)) }
        if (running && result == null) {
            item { Text("Working…", Modifier.padding(16.dp)) }
        }
        val error = (result as? Filters.Result.Error)?.message
        if (error != null) {
            item { Text(error, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) }
        }
        if (ok != null) {
            ok.warnings.forEach { warning ->
                item { Text(warning, Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall) }
            }
            for (list in ok.lists) {
                item { Header(list.query) }
                items(list.tasks, key = { it.id }) { task ->
                    TaskRow(task, state, today, showProject = true, onOpen = onOpenTask)
                }
                if (list.tasks.isEmpty()) {
                    item { Text("Nothing here.", Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall) }
                }
            }
            if (ok.lists.all { it.tasks.isEmpty() }) {
                item { Text("No tasks match this filter.", Modifier.padding(16.dp)) }
            }
        }
    }
}

/** The comments on a task, and a box to add one. */
@Composable
fun CommentsSection(state: AppState, taskId: String, canComment: Boolean) {
    val app = LocalContext.current.app
    val comments = remember(state, taskId) { Views.commentsOf(state, taskId) }
    var text by remember(taskId) { mutableStateOf("") }
    var editing by remember { mutableStateOf<Comment?>(null) }
    var deleting by remember { mutableStateOf<Comment?>(null) }

    Text("Comments", style = MaterialTheme.typography.titleSmall)
    if (comments.isEmpty()) {
        Text("No comments yet.", style = MaterialTheme.typography.bodySmall)
    }
    for (comment in comments) {
        CommentItem(
            comment = comment,
            state = state,
            editing = editing?.id == comment.id,
            onEdit = { editing = comment },
            onSave = { draft ->
                editing = null
                if (draft.trim() != comment.content) {
                    app.sendAll(
                        listOf(
                            "comment_update" to buildJsonObject {
                                put("id", comment.id)
                                put("content", draft.trim())
                            },
                        ),
                    )
                }
            },
            onDelete = { deleting = comment },
        )
    }
    if (!canComment) {
        Text("You can't comment on this project.", style = MaterialTheme.typography.bodySmall)
        return
    }
    OutlinedTextField(
        value = text,
        onValueChange = { text = it.take(15000) },
        label = { Text("Add a comment") },
        minLines = 1,
        modifier = Modifier.fillMaxWidth().imePadding(),
    )
    Button(
        enabled = text.isNotBlank(),
        onClick = {
            val content = text.trim()
            app.sendAll(
                listOf(
                    "comment_add" to buildJsonObject {
                        put("id", Ids.newId())
                        put("taskId", taskId)
                        put("content", content)
                    },
                ),
            )
            text = ""
        },
    ) { Text("Comment") }

    deleting?.let { comment ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete this comment?") },
            text = { Text("It can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    app.sendAll(listOf("comment_delete" to buildJsonObject { put("id", comment.id) }))
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

/** One comment: who wrote it, when, and (for your own) edit and delete. */
@Composable
private fun CommentItem(
    comment: Comment,
    state: AppState,
    editing: Boolean,
    onEdit: () -> Unit,
    onSave: (String) -> Unit,
    onDelete: () -> Unit,
) {
    val mine = comment.userId != null && comment.userId == state.user?.id
    val author = if (mine) {
        "You"
    } else {
        comment.userId?.let { state.people[it]?.username } ?: "Former member"
    }
    var draft by remember(comment.id, comment.content) { mutableStateOf(comment.content) }

    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(author, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
            Text(
                Dates.ago(comment.createdAt) + if (comment.updatedAt != comment.createdAt) " · edited" else "",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (mine) {
                IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "Edit comment") }
                IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "Delete comment") }
            }
        }
        if (editing) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it.take(15000) },
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onSave(draft) }) { Text("Save") }
                TextButton(onClick = onEdit) { Text("Cancel") }
            }
        } else {
            Text(comment.content, style = MaterialTheme.typography.bodyMedium)
        }
        if (comment.pending) {
            Text("Sending…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The user's local date and time in their synced zone (the "now" the filters use). */
private fun localNow(state: AppState): Pair<String, String> =
    QuickAdd.localNow(state.user?.timeZone ?: "UTC")
