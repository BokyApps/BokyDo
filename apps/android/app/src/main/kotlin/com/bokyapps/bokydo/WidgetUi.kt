package com.bokyapps.bokydo

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.CheckBox
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextDecoration
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.Appearance
import com.bokyapps.bokydo.core.Dates
import com.bokyapps.bokydo.core.QuickAdd
import com.bokyapps.bokydo.core.ThemeTokens
import com.bokyapps.bokydo.core.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Home-screen widgets (A4b): a task list (Today/Inbox/Upcoming/a project) with tap-to-complete
 * checkboxes, scroll and an add button, and a small quick-add button. All the list and theme
 * decisions live in `:core` `Widgets`; this file only renders them with Glance and turns taps
 * into the same commands the app sends.
 *
 * The widget reads the synced data and its own config on every update; the app refreshes the
 * placed widgets after a sync or a queued change ([WidgetRefresh]). Widgets are home-screen only
 * (`widgetCategory=home_screen`), so task text is never shown on the lock screen.
 */

/** Where a widget keeps its per-instance config; the Glance state definition (default). */
private val KEY_CONFIG = stringPreferencesKey("config")

/** Which task a tap-to-complete checkbox refers to. */
private val KEY_TASK_ID = ActionParameters.Key<String>("taskId")

/** What a widget shows and the colours it uses, resolved for the device now. */
private data class Screen(val title: String, val rows: List<Widgets.Row>, val tokens: ThemeTokens, val alpha: Int)

private fun systemDark(context: Context): Boolean =
    (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES

/** A theme token as a Glance provider, with the widget's transparency applied. */
private fun provider(argb: Long, alpha: Int): ColorProvider =
    ColorProvider(Color(argb).copy(alpha = alpha.coerceIn(0, 100) / 100f))

private fun screen(state: AppState, config: Widgets.Config, dark: Boolean, today: String): Screen {
    val appearance = state.user?.prefs?.appearance ?: Appearance.DEFAULT
    val target = config.target
    val title = when (target) {
        Widgets.Target.Inbox -> "Inbox"
        Widgets.Target.Today -> "Today"
        Widgets.Target.Upcoming -> "Upcoming"
        is Widgets.Target.Project -> state.projects[target.id]?.name ?: "Project"
    }
    return Screen(
        title = title,
        rows = Widgets.rows(state, target, today),
        tokens = Widgets.tokens(appearance, config.theme, dark),
        alpha = config.alpha,
    )
}

private fun todayIn(state: AppState): String =
    QuickAdd.localNow(state.user?.prefs?.timezone ?: state.user?.timeZone ?: "UTC").first

/** Tapping the widget header or a row opens the app; the checkbox completes the task. */
private fun quickAddIntent(context: Context) =
    Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_QUICK_ADD, true)

/** The task-list widget. */
class TodayWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val state = withContext(Dispatchers.Default) { context.app.appState() }
        val dark = systemDark(context)
        provideContent {
            val config = Widgets.decode(currentState<Preferences>()[KEY_CONFIG])
            TaskWidgetContent(state, config, dark)
        }
    }
}

/** The quick-add widget: one tap opens the app with the add sheet already up. */
class QuickAddWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val state = withContext(Dispatchers.Default) { context.app.appState() }
        val dark = systemDark(context)
        provideContent {
            val appearance = state.user?.prefs?.appearance ?: Appearance.DEFAULT
            val tokens = Widgets.tokens(appearance, "system", dark)
            val context = LocalContext.current
            Box(
                modifier = GlanceModifier.fillMaxSize()
                    .background(provider(tokens.accent, 100))
                    .clickable(actionStartActivity(quickAddIntent(context))),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "＋ Add task",
                    style = TextStyle(color = provider(tokens.accentFg, 100), fontWeight = FontWeight.Medium, fontSize = 14.sp),
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun TaskWidgetContent(state: AppState, config: Widgets.Config, dark: Boolean) {
    // Signed out: the widget shows nothing (and so no task titles) until the user signs in.
    if (state.user == null) return

    val context = LocalContext.current
    val view = screen(state, config, dark, todayIn(state))
    val openApp = actionStartActivity(Intent(context, MainActivity::class.java))
    val tokens = view.tokens

    Column(
        modifier = GlanceModifier.fillMaxSize().background(provider(tokens.bg, view.alpha)).padding(12.dp),
    ) {
        Row(modifier = GlanceModifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                view.title,
                modifier = GlanceModifier.clickable(openApp),
                style = TextStyle(color = provider(tokens.fg, view.alpha), fontWeight = FontWeight.Bold, fontSize = 16.sp),
                maxLines = 1,
            )
            Spacer(GlanceModifier.size(8.dp))
            Text(
                "＋",
                modifier = GlanceModifier.clickable(actionStartActivity(quickAddIntent(context))),
                style = TextStyle(color = provider(tokens.accent, view.alpha), fontWeight = FontWeight.Bold, fontSize = 18.sp),
                maxLines = 1,
            )
        }
        if (view.rows.isEmpty()) {
            Text("Nothing here.", style = TextStyle(color = provider(tokens.muted, view.alpha), fontSize = 13.sp))
        } else {
            LazyColumn(modifier = GlanceModifier.fillMaxSize()) {
                items(view.rows) { row -> TaskLine(row, view, openApp) }
            }
        }
    }
}

@Composable
private fun TaskLine(row: Widgets.Row, screen: Screen, openApp: Action) {
    val tokens = screen.tokens
    val meta = listOfNotNull(row.due, row.project).joinToString(" · ")
    Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp).clickable(openApp)) {
        CheckBox(
            checked = row.completed,
            onCheckedChange = actionRunCallback<CompleteTaskAction>(actionParametersOf(KEY_TASK_ID to row.id)),
            text = row.content,
            style = TextStyle(
                color = provider(tokens.fg, screen.alpha),
                fontSize = 14.sp,
                textDecoration = if (row.completed) TextDecoration.LineThrough else null,
            ),
            maxLines = 1,
        )
        if (meta.isNotEmpty()) {
            Text(
                meta,
                modifier = GlanceModifier.padding(start = 8.dp),
                style = TextStyle(color = provider(toneColor(row.tone, tokens), screen.alpha), fontSize = 12.sp),
                maxLines = 1,
            )
        }
    }
}

private fun toneColor(tone: Dates.Tone?, tokens: ThemeTokens): Long = when (tone) {
    Dates.Tone.OVERDUE -> tokens.p1
    Dates.Tone.TODAY -> tokens.p2
    else -> tokens.muted
}

/** Completing from the widget queues the same command the app sends, then redraws. */
class CompleteTaskAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[KEY_TASK_ID] ?: return
        withContext(Dispatchers.IO) { context.app.send("task_complete", id) }
        TodayWidget().update(context, glanceId)
    }
}

class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()
}

class QuickAddWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = QuickAddWidget()
}

/** Persist a widget's config, then redraw it (called by the config screen). */
internal suspend fun saveWidgetConfig(context: Context, appWidgetId: Int, config: Widgets.Config) {
    val manager = GlanceAppWidgetManager(context)
    val id = manager.getGlanceIdBy(appWidgetId)
    updateAppWidgetState(context, id) { prefs -> prefs[KEY_CONFIG] = Widgets.encode(config) }
    TodayWidget().update(context, id)
}

/** Redraw every placed instance after a sync or a queued change. */
object WidgetRefresh {
    suspend fun updateAll(context: Context) {
        TodayWidget().updateAll(context)
        QuickAddWidget().updateAll(context)
    }
}
