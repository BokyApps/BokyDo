package com.bokyapps.bokydo

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.glance.LocalContext
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.HabitCheckIn
import com.bokyapps.bokydo.core.HabitsResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal data class WidgetSnapshot(
    val account: String? = null,
    val state: AppState = AppState.EMPTY,
    val habits: HabitsResponse? = null,
    val pending: List<HabitCheckIn> = emptyList(),
    val habitError: String? = null,
)

/** An active Glance session recomposes on update; provideGlance itself need not run again.
 * Observe SQLite changes inside its content, keeping each snapshot bound to one login. */
@Composable
internal fun widgetSnapshot(): WidgetSnapshot {
    val app = LocalContext.current.app
    val version by app.store.version.collectAsState()
    val snapshot by produceState(WidgetSnapshot(), version) {
        value = withContext(Dispatchers.IO) {
            val account = app.accountEpoch()
            if (account == null) WidgetSnapshot() else {
                val next = WidgetSnapshot(account, app.appState(), app.store.cachedHabits(account), app.store.pendingHabits(account), app.store.habitError(account))
                if (account == app.accountEpoch()) next else WidgetSnapshot()
            }
        }
    }
    return snapshot
}
