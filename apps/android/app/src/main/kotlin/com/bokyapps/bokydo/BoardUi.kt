package com.bokyapps.bokydo

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.Dates
import com.bokyapps.bokydo.core.Section
import com.bokyapps.bokydo.core.Task
import com.bokyapps.bokydo.core.Views
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The project board (PLAN §9 A2d): one column per section, like the web's Kanban view. Cards
 * can be completed, opened and moved to another column.
 */
@Composable
fun BoardView(state: AppState, projectId: String, today: String, onOpen: (String) -> Unit) {
    val app = LocalContext.current.app
    val sections = remember(state, projectId) { Views.sectionsOf(state, projectId) }
    val columns = remember(state, projectId, sections) { Views.boardColumns(state, projectId) }
    var moving by remember { mutableStateOf<Task?>(null) }

    LazyRow(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(columns, key = { it.section?.id ?: "none" }) { column ->
            Column(
                Modifier
                    .width(260.dp)
                    .fillMaxHeight()
                    .background(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.medium)
                    .padding(10.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(column.section?.name ?: "(No section)", style = MaterialTheme.typography.titleSmall)
                Text("${column.tasks.size}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                for (task in column.tasks) {
                    BoardCard(
                        task = task,
                        state = state,
                        today = today,
                        onOpen = { onOpen(task.id) },
                        onMove = { moving = task },
                    )
                }
                if (column.tasks.isEmpty()) {
                    Text(
                        "Nothing here",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }

    moving?.let { task ->
        MoveDialog(
            sections = sections,
            current = task.sectionId,
            onDismiss = { moving = null },
            onMove = { sectionId ->
                moving = null
                app.sendAll(
                    listOf(
                        "task_move" to buildJsonObject {
                            put("id", task.id)
                            put("sectionId", sectionId)
                        },
                    ),
                )
            },
        )
    }
}

/** A task as a card: complete it, open it, or move it to another column. */
@Composable
private fun BoardCard(
    task: Task,
    state: AppState,
    today: String,
    onOpen: () -> Unit,
    onMove: () -> Unit,
) {
    val app = LocalContext.current.app
    val prefs = state.prefs()
    val due = task.due?.let { Dates.dueLabel(it, today, prefs) }
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.small)
            .padding(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Checkbox(
                checked = task.isCompleted,
                onCheckedChange = { done ->
                    app.send(if (done) "task_complete" else "task_uncomplete", task.id)
                },
                colors = CheckboxDefaults.colors(uncheckedColor = priorityColor(task.priority)),
            )
            Column(Modifier.weight(1f)) {
                Text(
                    task.content,
                    style = MaterialTheme.typography.bodyMedium,
                    textDecoration = if (task.isCompleted) TextDecoration.LineThrough else null,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.clickable { onOpen() },
                )
                if (due != null) {
                    Text(
                        due,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            IconButton(onClick = onMove) {
                Icon(Icons.Filled.MoreVert, contentDescription = "Move to another section")
            }
        }
    }
}

/** Pick the column a task moves to. */
@Composable
private fun MoveDialog(
    sections: List<Section>,
    current: String?,
    onDismiss: () -> Unit,
    onMove: (String?) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Move to") },
        text = {
            Column {
                TextButton(onClick = { onMove(null) }) { Text("(No section)") }
                for (section in sections) {
                    TextButton(onClick = { onMove(section.id) }) {
                        Text(if (section.id == current) "${section.name} ✓" else section.name)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
