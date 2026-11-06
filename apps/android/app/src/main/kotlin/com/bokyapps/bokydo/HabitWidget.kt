package com.bokyapps.bokydo

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.CheckBox
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ToggleableStateKey
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import com.bokyapps.bokydo.WidgetText as Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import androidx.glance.semantics.semantics
import androidx.glance.semantics.contentDescription
import com.bokyapps.bokydo.core.Appearance
import com.bokyapps.bokydo.core.QuickAdd
import com.bokyapps.bokydo.core.Widgets
import com.bokyapps.bokydo.core.habitRows
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val HABIT_ID = ActionParameters.Key<String>("habitId")
private val HABIT_DATE = ActionParameters.Key<String>("habitDate")
private val HABIT_OWNER = ActionParameters.Key<String>("habitOwner")
private val HABIT_DONE = ActionParameters.Key<Boolean>("habitDone")

/** Scrollable daily check-ins, backed by the same durable queue as the app's Habits screen. */
class HabitWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val app = context.app
            val snapshot = widgetSnapshot()
            val account = snapshot.account
            val state = snapshot.state
            val today = QuickAdd.localNow(state.user?.prefs?.timezone ?: state.user?.timeZone ?: "UTC").first
            val rows = habitRows(snapshot.habits, snapshot.pending, today, state.user?.prefs?.weekStart ?: "monday")
            val cached = snapshot.habits != null
            val error = snapshot.habitError
            val dark = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            val tokens = Widgets.tokens(state.user?.prefs?.appearance ?: Appearance.DEFAULT, "system", dark)
            val open = actionStartActivity(Intent(LocalContext.current, MainActivity::class.java).putExtra(MainActivity.EXTRA_DESTINATION, "habits"))
            Column(GlanceModifier.fillMaxSize().background(ColorProvider(Color(tokens.bg))).padding(12.dp)) {
                Row(GlanceModifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Habits", GlanceModifier.clickable(open), style = TextStyle(color = ColorProvider(Color(tokens.fg)), fontSize = 16.sp, fontWeight = FontWeight.Bold))
                    Spacer(GlanceModifier.defaultWeight())
                    Text("↻", GlanceModifier.padding(8.dp).clickable(actionRunCallback<RefreshWidgetsAction>()), style = TextStyle(color = ColorProvider(Color(tokens.accent)), fontSize = 18.sp))
                }
                if (account == null || state.user == null || app.accountEpoch() != account) {
                    Text("Sign in to track habits.", GlanceModifier.clickable(open), style = TextStyle(color = ColorProvider(Color(tokens.muted))))
                } else {
                    Text(today, style = TextStyle(color = ColorProvider(Color(tokens.muted)), fontSize = 12.sp))
                    if (error != null) Text("Check-in needs attention. Open Habits.", GlanceModifier.clickable(open), style = TextStyle(color = ColorProvider(Color(tokens.p1)), fontSize = 12.sp))
                    if (rows.isEmpty()) Text(if (cached) "No habits yet. Open Habits." else "Tap ↻ to load habits.", GlanceModifier.padding(top = 8.dp).clickable(open), style = TextStyle(color = ColorProvider(Color(tokens.muted))))
                    LazyColumn(GlanceModifier.fillMaxSize()) {
                        items(rows.take(12)) { row ->
                            Column(GlanceModifier.fillMaxWidth().padding(vertical = 4.dp)) {
                                Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                CheckBox(
                                    checked = row.completed,
                                    modifier = GlanceModifier.semantics { contentDescription = row.name },
                                    onCheckedChange = actionRunCallback<HabitCheckInAction>(actionParametersOf(HABIT_ID to row.id, HABIT_DATE to today, HABIT_OWNER to account, HABIT_DONE to !row.completed)),
                                    text = "",
                                    maxLines = 2,
                                    style = TextStyle(color = ColorProvider(Color(tokens.fg)), fontSize = 14.sp),
                                )
                                Text(row.name, maxLines = 2, style = TextStyle(color = ColorProvider(Color(tokens.fg)), fontSize = 14.sp))
                                }
                                Text("${row.progress}/${row.target} ${if (row.period == "day") "today" else "this week"}${if (row.pending) " · saving" else ""}", GlanceModifier.padding(start = 8.dp), style = TextStyle(color = ColorProvider(Color(tokens.muted)), fontSize = 12.sp))
                            }
                        }
                        if (rows.size > 12) item { Text("Open Habits for more", GlanceModifier.padding(8.dp).clickable(open), style = TextStyle(color = ColorProvider(Color(tokens.accent)))) }
                    }
                }
            }
        }
    }
}

class HabitWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = HabitWidget()
}

class HabitCheckInAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val owner = parameters[HABIT_OWNER] ?: return
        val id = parameters[HABIT_ID] ?: return
        val date = parameters[HABIT_DATE] ?: return
        val completed = parameters[ToggleableStateKey] ?: parameters[HABIT_DONE] ?: return
        withContext(Dispatchers.IO) {
            val app = context.app
            val state = app.appState()
            val today = QuickAdd.localNow(state.user?.prefs?.timezone ?: state.user?.timeZone ?: "UTC").first
            if (app.accountEpoch() == owner && date == today) app.checkInHabit(owner, id, date, completed)
            else app.syncNow()
        }
        HabitWidget().update(context, glanceId)
    }
}

class RefreshWidgetsAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        context.app.syncNow()
        WidgetRefresh.updateAll(context)
    }
}
