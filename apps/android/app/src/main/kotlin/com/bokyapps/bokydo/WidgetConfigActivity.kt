package com.bokyapps.bokydo

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.Views
import com.bokyapps.bokydo.core.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The screen the launcher opens when the task widget is added (A4b): choose which list it shows
 * and how it follows the theme. Returns the app-widget id on Save so the host keeps the widget.
 */
class WidgetConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        // Default to cancelled: a host that gets no answer removes the widget.
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        val bokyDo = this.app
        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    val state by produceState(AppState.EMPTY) {
                        value = withContext(Dispatchers.Default) { bokyDo.appState() }
                    }
                    WidgetConfigScreen(
                        state = state,
                        onCancel = { finish() },
                        onSave = { config ->
                            if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
                                finish()
                            } else {
                                MainScope().launch {
                                    saveWidgetConfig(this@WidgetConfigActivity, appWidgetId, config)
                                    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
                                    finish()
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun WidgetConfigScreen(state: AppState, onCancel: () -> Unit, onSave: (Widgets.Config) -> Unit) {
    var target by remember { mutableStateOf<Widgets.Target>(Widgets.Target.Today) }
    var theme by remember { mutableStateOf("system") }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("What this widget shows", style = MaterialTheme.typography.titleMedium)
        val options = buildList {
            add(Widgets.Target.Today to "Today (overdue and today)")
            add(Widgets.Target.Inbox to "Inbox")
            add(Widgets.Target.Upcoming to "Upcoming (two weeks)")
            for ((project, depth) in Views.projectTree(state)) {
                add(Widgets.Target.Project(project.id) to "  ".repeat(depth) + project.name)
            }
        }
        for ((option, label) in options) {
            Row(
                Modifier.fillMaxWidth().clickable { target = option }.padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = target == option, onClick = { target = option })
                Text(label)
            }
        }
        Text("Theme", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
        for ((mode, label) in listOf("system" to "Follow system", "light" to "Light", "dark" to "Dark")) {
            Row(
                Modifier.fillMaxWidth().clickable { theme = mode }.padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = theme == mode, onClick = { theme = mode })
                Text(label)
            }
        }
        Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = { onSave(Widgets.Config(target, theme, 100)) }) { Text("Save") }
            OutlinedButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}
