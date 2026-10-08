package com.bokyapps.bokydo

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.bokyapps.bokydo.core.AppState
import com.bokyapps.bokydo.core.BokyDoClient
import com.bokyapps.bokydo.core.ENTITY_TYPES
import com.bokyapps.bokydo.core.Optimistic
import com.bokyapps.bokydo.core.SNAPSHOT_KEYS
import com.bokyapps.bokydo.core.DiscoveryCheck
import com.bokyapps.bokydo.core.EventStream
import com.bokyapps.bokydo.core.PendingAuth
import com.bokyapps.bokydo.core.RedirectResult
import com.bokyapps.bokydo.core.ServerAddress
import com.bokyapps.bokydo.core.ServerException
import com.bokyapps.bokydo.core.SignedOutException
import com.bokyapps.bokydo.core.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What the app is doing, for the UI. */
sealed interface AppScreen {
    data class Connect(val message: String? = null) : AppScreen
    data class WaitingForBrowser(val host: String) : AppScreen
    data object Home : AppScreen
}

/** The app's objects, built once. */
class BokyDoApp : Application() {
    lateinit var vault: Vault
    lateinit var sessions: VaultSessionStore
    lateinit var pendingAuth: PendingAuthStore
    lateinit var store: SqliteStore
    lateinit var client: BokyDoClient
    lateinit var engine: SyncEngine
    lateinit var quickAddParser: QuickAddParser
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _screen = MutableStateFlow<AppScreen>(AppScreen.Connect())
    val screen: StateFlow<AppScreen> = _screen
    val syncError = MutableStateFlow<String?>(null)
    private lateinit var liveSync: LiveSync

    override fun onCreate() {
        super.onCreate()
        vault = Vault(this)
        sessions = VaultSessionStore(vault)
        pendingAuth = PendingAuthStore(vault)
        store = SqliteStore(this)
        client = BokyDoClient(sessions)
        engine = SyncEngine(client, store)
        quickAddParser = QuickAddParser(this)
        Notifier.createChannels(this)
        UnifiedPush.load(this)
        if (sessions.load() != null) {
            _screen.value = AppScreen.Home
            schedulePeriodicSync()
            // Anything missed while the app wasn't running (e.g. right after an update).
            ReminderAlarms.reschedule(this)
        }
        liveSync = LiveSync(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(liveSync)
    }

    // ---- sign-in ----

    /** Check the server and open its sign-in page in a Custom Tab (MFA and passkeys work there). */
    suspend fun startSignIn(context: Context, address: ServerAddress): String? {
        val discovery = try {
            client.discover(address)
        } catch (e: ServerException) {
            return if (e.status == 404) "That doesn't look like a BokyDo server (or its public address isn't set yet)."
            else "The server answered with an error (${e.status})."
        } catch (_: IOException) {
            return "Couldn't reach ${address.host}. Check the address and your connection."
        } catch (_: Exception) {
            return "That doesn't look like a BokyDo server."
        }
        when (val check = discovery.check(address)) {
            DiscoveryCheck.Ok -> Unit
            DiscoveryCheck.NotBokyDo -> return "That doesn't look like a BokyDo server."
            DiscoveryCheck.Inconsistent -> return "This server's sign-in settings don't match its address. Ask its admin."
            is DiscoveryCheck.DifferentAddress -> return "This server's address is ${check.publicUrl}. Use that instead."
        }
        val pending = PendingAuth.start(address.origin, discovery, System.currentTimeMillis())
        pendingAuth.put(pending)
        _screen.value = AppScreen.WaitingForBrowser(address.host)
        try {
            CustomTabsIntent.Builder().setShareState(CustomTabsIntent.SHARE_STATE_OFF).build()
                .launchUrl(context, Uri.parse(pending.authorizationUrl()))
        } catch (_: ActivityNotFoundException) {
            pendingAuth.clear()
            _screen.value = AppScreen.Connect()
            return "Signing in needs a web browser. Install one and try again."
        }
        return null
    }

    /** The browser came back with the redirect. */
    suspend fun finishSignIn(redirect: String) {
        val pending = pendingAuth.take()
        if (pending == null) {
            // Any app can send this redirect. With no sign-in in progress it means nothing: never
            // let it disturb a signed-in user.
            if (sessions.load() == null) {
                _screen.value = AppScreen.Connect("This sign-in link has already been used or has expired.")
            }
            return
        }
        when (val result = pending.accept(redirect, System.currentTimeMillis())) {
            is RedirectResult.Failed -> _screen.value = AppScreen.Connect(result.reason)
            RedirectResult.Denied -> _screen.value = AppScreen.Connect("Sign-in was cancelled.")
            is RedirectResult.Code -> try {
                client.exchangeCode(pending, result.code)
                store.clear()
                _screen.value = AppScreen.Home
                schedulePeriodicSync()
                syncNow()
                liveSync.restart()
            } catch (_: Exception) {
                _screen.value = AppScreen.Connect("Signing in didn't finish. Try again.")
            }
        }
    }

    fun cancelSignIn() {
        pendingAuth.clear()
        _screen.value = AppScreen.Connect()
    }

    suspend fun signOut(message: String? = null) {
        // Revoking the grant also ends the push registration on the server.
        UnifiedPush.unregister(this, tellServer = false)
        client.signOut()
        store.clear()
        ReminderAlarms.clear(this)
        WorkManager.getInstance(this).cancelUniqueWork(PERIODIC)
        _screen.value = AppScreen.Connect(message)
    }

    // ---- data ----

    /** The last [appState] read, shown while the next one is decoded. */
    @Volatile
    var lastState: AppState = AppState.EMPTY
        private set

    /** What the screens show: the synced data with queued changes applied. Reads the database. */
    fun appState(): AppState = Optimistic.apply(
        AppState.decode(ENTITY_TYPES.associateWith { store.all(it) }, SNAPSHOT_KEYS.associateWith { store.snapshot(it) }),
        store.pending(Int.MAX_VALUE),
    ).also { lastState = it }

    /** Queue a change on one entity (`{ id }` args) and send it as soon as possible. */
    fun send(type: String, id: String) = sendAll(listOf(type to buildJsonObject { put("id", id) }))

    /** Queue changes in order (shown at once, kept offline) and send them as soon as possible. */
    fun sendAll(commands: List<Pair<String, JsonObject>>) {
        for ((type, args) in commands) engine.enqueue(type, args)
        syncNow()
    }

    // ---- sync ----

    suspend fun sync() {
        try {
            engine.sync()
            syncError.value = null
            // Due dates and reminders may have changed: re-arm the next alarm.
            ReminderAlarms.reschedule(this)
        } catch (_: SignedOutException) {
            signOut("You were signed out. Sign in again to keep syncing.")
        } catch (e: ServerException) {
            syncError.value = "Sync failed (${e.status})."
            throw e
        } catch (e: IOException) {
            syncError.value = "Offline. Changes are kept and sent later."
            throw e
        }
    }

    fun syncNow() {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(this).enqueueUniqueWork(ONE_TIME, ExistingWorkPolicy.REPLACE, request)
    }

    private fun schedulePeriodicSync() {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    companion object {
        private const val PERIODIC = "sync-periodic"
        private const val ONE_TIME = "sync-now"
    }
}

val Context.app: BokyDoApp get() = applicationContext as BokyDoApp

/** Background sync (periodic, and right after changes or sign-in). */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (applicationContext.app.sessions.load() == null) return Result.success()
        return try {
            applicationContext.app.sync()
            Result.success()
        } catch (e: ServerException) {
            if (e.status >= 500 || e.status == 429) Result.retry() else Result.failure()
        } catch (_: IOException) {
            Result.retry()
        }
    }
}

/**
 * While the app is in the foreground: listen to the server's event stream and sync on every
 * poke; reconnect with backoff. Stops when the app goes to the background (WorkManager takes
 * over), so there's no long-lived connection draining the battery.
 */
class LiveSync(private val app: BokyDoApp) : DefaultLifecycleObserver {
    private var job: Job? = null

    override fun onStart(owner: LifecycleOwner) = start()

    /** After signing in: start listening now if the app is in the foreground. */
    fun restart() {
        // Lifecycle state is read on the main thread.
        app.scope.launch(Dispatchers.Main) {
            val state = ProcessLifecycleOwner.get().lifecycle.currentState
            if (state.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) start()
        }
    }

    @Synchronized
    private fun start() {
        job?.cancel()
        job = app.scope.launch {
            var backoff = 2_000L
            while (isActive && app.sessions.load() != null) {
                try {
                    app.sync()
                    app.client.let { EventStream(it, app.sessions) }.pokes().conflate().collect {
                        app.sync()
                        backoff = 2_000L
                    }
                } catch (_: Exception) {
                    // Offline, server restarting or token refreshing: try again shortly.
                }
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(60_000L)
            }
        }
    }

    @Synchronized
    override fun onStop(owner: LifecycleOwner) {
        job?.cancel()
        job = null
    }
}
