package com.bokyapps.bokydo

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.bokyapps.bokydo.core.Json
import com.bokyapps.bokydo.core.Reminders
import com.bokyapps.bokydo.core.ScheduledReminder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.ZoneId

/**
 * Reminders are scheduled on the device as exact alarms (PLAN D7): they go off on time offline
 * and without any push service. One alarm is set at a time, for the next reminder; when it fires,
 * everything due is shown and the next one is set. The schedule is rebuilt after every sync and
 * on boot, time or time-zone changes and app updates.
 */
object ReminderAlarms {
    private const val PREFS = "reminders"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Reminders already shown, by key (id@time), so each goes off once. */
    private fun shown(context: Context): Set<String> = prefs(context).getStringSet("shown", emptySet()) ?: emptySet()

    private fun snoozed(context: Context): List<ScheduledReminder> =
        snoozedRaw(context).map { ScheduledReminder("snooze:${it.reminderId}", it.taskId, it.title, it.until) }

    /** The user's zone for floating times: as synced (preference or instance default), else the device's. */
    fun userZone(app: BokyDoApp): String =
        ((app.store.snapshot("user") as? JsonObject)?.get("timeZone") as? JsonPrimitive)?.content
            ?: ZoneId.systemDefault().id

    private fun schedule(app: BokyDoApp): List<ScheduledReminder> {
        val tasks = app.store.all("tasks").associateBy { (it["id"] as JsonPrimitive).content }
        return (Reminders.schedule(app.store.all("reminders"), tasks, userZone(app)) + snoozed(app))
            .sortedBy { it.fireAt }
    }

    /** Show what's due, forget what's stale, and set the alarm for the next one. */
    @Synchronized
    fun reschedule(context: Context, show: Boolean = true) {
        val app = context.app
        val alarms = context.getSystemService(AlarmManager::class.java)
        val pending = alarmIntent(context)
        if (app.sessions.load() == null) {
            alarms.cancel(pending)
            return
        }
        val now = System.currentTimeMillis()
        val all = schedule(app)
        var shown = shown(context)
        if (show) {
            for (r in Reminders.due(all, shown, now)) Notifier.reminder(context, r)
            shown = shown + Reminders.due(all, shown, now).map { it.key }
        }
        // Keep only keys that can still matter (anything older can't go off again anyway).
        val live = all.filter { now - it.fireAt <= Reminders.LATE_LIMIT_MS }.map { it.key }.toSet()
        val p = prefs(context).edit().putStringSet("shown", shown.intersect(live))
        val remainingSnoozes = snoozedRaw(context).filter { it.until > now }
        p.putString("snoozed", Snooze.encode(remainingSnoozes)).apply()

        val next = Reminders.next(all, shown, now)
        if (next == null) {
            alarms.cancel(pending)
        } else if (canScheduleExact(context)) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pending)
        } else {
            // Without the exact-alarm permission: Android may deliver it a few minutes late.
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pending)
        }
    }

    fun canScheduleExact(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()

    fun snooze(context: Context, reminder: ScheduledReminder, minutes: Int) {
        val until = System.currentTimeMillis() + minutes * 60_000L
        val list = snoozedRaw(context).filter { it.reminderId != reminder.reminderId } +
            Snooze(reminder.reminderId, reminder.taskId, reminder.title, until)
        prefs(context).edit().putString("snoozed", Snooze.encode(list)).apply()
        reschedule(context, show = false)
    }

    private fun snoozedRaw(context: Context): List<Snooze> =
        Snooze.decode(prefs(context).getString("snoozed", null))

    fun clear(context: Context) {
        context.getSystemService(AlarmManager::class.java).cancel(alarmIntent(context))
        prefs(context).edit().clear().apply()
        NotificationManagerCompat.from(context).cancelAll()
    }

    private fun alarmIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, ReminderAlarmReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private data class Snooze(val reminderId: String, val taskId: String, val title: String, val until: Long) {
        companion object {
            fun encode(list: List<Snooze>): String = JsonArray(
                list.map {
                    buildJsonObject {
                        put("reminderId", it.reminderId)
                        put("taskId", it.taskId)
                        put("title", it.title)
                        put("until", it.until)
                    }
                },
            ).toString()

            fun decode(raw: String?): List<Snooze> = runCatching {
                (Json.parseToJsonElement(raw ?: "[]") as JsonArray).mapNotNull { e ->
                    val o = e as? JsonObject ?: return@mapNotNull null
                    fun str(k: String) = (o[k] as? JsonPrimitive)?.content
                    Snooze(str("reminderId") ?: return@mapNotNull null, str("taskId") ?: return@mapNotNull null, str("title") ?: "", str("until")?.toLongOrNull() ?: return@mapNotNull null)
                }
            }.getOrDefault(emptyList())
        }
    }
}

/** The reminder alarm went off. Not exported: only our own PendingIntent reaches it. */
class ReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = ReminderAlarms.reschedule(context)
}

/**
 * Re-arm after a reboot (alarms don't survive one), a clock or time-zone change (fire times move)
 * and an app update. These are protected broadcasts: only the system can send them.
 */
class SystemEventsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED,
            -> ReminderAlarms.reschedule(context, show = false)
        }
    }
}

/** Buttons on a reminder: complete the task, or snooze. Not exported. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.app
        val taskId = intent.getStringExtra(EXTRA_TASK) ?: return
        val tag = intent.getStringExtra(EXTRA_TAG) ?: taskId
        if (app.sessions.load() == null) return
        when (intent.action) {
            ACTION_COMPLETE -> {
                // A change like any other: queued, sent with the next sync, safe offline.
                app.engine.enqueue("task_complete", buildJsonObject { put("id", taskId) })
                app.syncNow()
            }
            ACTION_SNOOZE -> {
                val reminder = ScheduledReminder(
                    intent.getStringExtra(EXTRA_REMINDER) ?: return,
                    taskId,
                    intent.getStringExtra(EXTRA_TITLE) ?: "",
                    0,
                )
                ReminderAlarms.snooze(context, reminder, intent.getIntExtra(EXTRA_MINUTES, 15).coerceIn(1, 24 * 60))
            }
            else -> return
        }
        NotificationManagerCompat.from(context).cancel(tag, Notifier.ID)
    }

    companion object {
        const val ACTION_COMPLETE = "com.bokyapps.bokydo.action.COMPLETE"
        const val ACTION_SNOOZE = "com.bokyapps.bokydo.action.SNOOZE"
        const val EXTRA_TASK = "task"
        const val EXTRA_REMINDER = "reminder"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TAG = "tag"
        const val EXTRA_MINUTES = "minutes"
    }
}

/** Notification channels and how each kind of notification looks. */
object Notifier {
    const val ID = 1
    private const val CHANNEL_REMINDERS = "reminders"
    private const val CHANNEL_ACTIVITY = "activity"

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_REMINDERS, "Reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Task reminders, scheduled on this device"
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ACTIVITY, "Activity", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Assignments, mentions, comments and invitations"
            },
        )
    }

    fun allowed(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun openApp(context: Context, requestCode: Int): PendingIntent =
        PendingIntent.getActivity(
            context,
            requestCode,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private fun action(context: Context, action: String, requestCode: Int, extras: Intent.() -> Unit): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(context, NotificationActionReceiver::class.java).setAction(action).apply(extras),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    fun reminder(context: Context, r: ScheduledReminder) {
        if (!allowed(context)) return
        val code = r.reminderId.hashCode()
        val extras: Intent.() -> Unit = {
            putExtra(NotificationActionReceiver.EXTRA_TASK, r.taskId)
            putExtra(NotificationActionReceiver.EXTRA_REMINDER, r.reminderId.removePrefix("snooze:"))
            putExtra(NotificationActionReceiver.EXTRA_TITLE, r.title)
            putExtra(NotificationActionReceiver.EXTRA_TAG, r.taskId)
        }
        val n = NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(r.title.ifBlank { "Reminder" })
            .setContentText("Reminder")
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setWhen(r.fireAt.takeIf { it > 0 } ?: System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            // The server may also push this reminder: same tag, so it replaces quietly.
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(context, code))
            .addAction(0, "Complete", action(context, NotificationActionReceiver.ACTION_COMPLETE, code, extras))
            .addAction(
                0,
                "Snooze 15 min",
                action(context, NotificationActionReceiver.ACTION_SNOOZE, code + 1) {
                    extras()
                    putExtra(NotificationActionReceiver.EXTRA_MINUTES, 15)
                },
            )
            .addAction(
                0,
                "1 hour",
                action(context, NotificationActionReceiver.ACTION_SNOOZE, code + 2) {
                    extras()
                    putExtra(NotificationActionReceiver.EXTRA_MINUTES, 60)
                },
            )
            .build()
        notify(context, r.taskId, n)
    }

    /** A message the server pushed (decrypted on this device): an assignment, mention, … */
    fun pushed(context: Context, title: String, body: String, tag: String?) {
        if (!allowed(context)) return
        val t = tag ?: title
        val n = NotificationCompat.Builder(context, CHANNEL_ACTIVITY)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.take(200))
            .setContentText(body.take(500))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(500)))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(context, t.hashCode()))
            .build()
        notify(context, t, n)
    }

    @Suppress("MissingPermission") // checked in allowed()
    private fun notify(context: Context, tag: String, n: android.app.Notification) {
        if (!allowed(context)) return
        NotificationManagerCompat.from(context).notify(tag, ID, n)
    }
}
