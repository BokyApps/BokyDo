package com.bokyapps.bokydo

import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.test.platform.app.InstrumentationRegistry
import com.bokyapps.bokydo.core.*
import java.io.File
import junit.framework.TestCase
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*

/** Runs only on a disposable emulator/loopback API fixture. Never signs in as the real owner. */
class WidgetsDeviceTest : TestCase() {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val app get() = context.applicationContext as BokyDoApp

    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun eventually(message: String, check: () -> Boolean) {
        val end = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < end) {
            var ok = false
            instrumentation.runOnMainSync { ok = check() }
            if (ok) return
            Thread.sleep(200)
        }
        fail(message)
    }

    fun testDatabaseMigrationPreservesVersionOneTasksAndQueue() {
        val name = "widget-migration-test.db"
        context.deleteDatabase(name)
        val db = context.openOrCreateDatabase(name, 0, null)
        db.execSQL("create table entities (type text not null,id text not null,json text not null,primary key(type,id))")
        db.execSQL("create table snapshots (name text primary key,json text not null)")
        db.execSQL("create table meta (key text primary key,value text not null)")
        db.execSQL("create table queue (seq integer primary key autoincrement,uuid text not null unique,type text not null,args text not null)")
        db.execSQL("create table rejections (uuid text primary key,type text not null,args text not null,error text not null,message text,at integer not null)")
        db.execSQL("insert into entities values ('tasks','t','{}')")
        db.execSQL("insert into meta values ('cursor','retained-cursor')")
        db.execSQL("insert into queue(uuid,type,args) values ('q','task_complete','{}')")
        db.version = 1
        db.close()
        val migrated = SqliteStore(context, name)
        try {
            assertEquals(1, migrated.count("tasks"))
            assertEquals("retained-cursor", migrated.cursor())
            assertEquals(1, migrated.pendingCount())
            migrated.ensureAccountEpoch()
            assertTrue(migrated.pendingHabits(migrated.accountEpoch()!!).isEmpty())
        } finally { migrated.close(); context.deleteDatabase(name) }
    }

    fun testWidgetsRenderConfiguredListsAndTrackAHabit() = runBlocking {
        val fixture = Json.parseToJsonElement(File(context.filesDir, "widget-fixture.json").readText()).jsonObject
        val session = Json.decodeFromJsonElement(Session.serializer(), fixture.getValue("session"))
        assertTrue(session.origin.startsWith("http://127.0.0.1:"))
        app.sessions.save(session)
        app.store.clear()
        app.store.ensureAccountEpoch()
        app.sync()
        val owner = app.accountEpoch()!!
        val habitId = fixture.getValue("habitId").jsonPrimitive.content
        val projectId = fixture.getValue("projectId").jsonPrimitive.content
        val today = app.store.cachedHabits(owner)!!.today
        app.client.call("PUT", "/api/v1/habits/$habitId/check-ins/$today", buildJsonObject { put("completed", false) })
        app.sync()
        val host = AppWidgetHost(context, 7391)
        val manager = AppWidgetManager.getInstance(context)
        val tasks = host.allocateAppWidgetId()
        val habits = host.allocateAppWidgetId()
        assertTrue("Grant widget binding to the disposable app via adb appwidget grantbind", manager.bindAppWidgetIdIfAllowed(tasks, ComponentName(context, TodayWidgetReceiver::class.java)))
        assertTrue(manager.bindAppWidgetIdIfAllowed(habits, ComponentName(context, HabitWidgetReceiver::class.java)))
        saveWidgetConfig(context, tasks, Widgets.Config(Widgets.Target.Inbox, "light", 100))
        val glanceId = GlanceAppWidgetManager(context).getGlanceIdBy(habits)
        HabitWidget().update(context, glanceId)
        val activity = instrumentation.startActivitySync(Intent(context, WidgetTestHostActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("ids", intArrayOf(tasks, habits))) as WidgetTestHostActivity
        try {
            fun hasText(text: String) = views(activity.content).any { it.contentDescription?.toString() == text || (it is android.widget.TextView && it.text.toString() == text) }
            eventually("Inbox task renders through the real widget host") { hasText("Inbox fixture") }
            eventually("Habit renders through the real widget host") { hasText("Daily widget habit") }
            saveWidgetConfig(context, tasks, Widgets.Config(Widgets.Target.Today, "light", 100))
            eventually("Today widget selection") { hasText("Today fixture") }
            saveWidgetConfig(context, tasks, Widgets.Config(Widgets.Target.Upcoming, "light", 100))
            eventually("Upcoming widget selection") { hasText("Upcoming fixture") }
            saveWidgetConfig(context, tasks, Widgets.Config(Widgets.Target.Project(projectId), "light", 100))
            eventually("Specific project widget selection") { hasText("Project fixture") }
            // Click the actual RemoteViews checkbox: exercise its PendingIntent and Glance callback.
            fun checkbox() = views(activity.content).firstOrNull {
                it.contentDescription?.toString() == "Daily widget habit" && it.isClickable
            }
            eventually("Habit checkbox is accessible and interactive") { checkbox() != null }
            instrumentation.runOnMainSync { checkbox()!!.performClick() }
            val end = System.currentTimeMillis() + 30_000
            while (System.currentTimeMillis() < end) {
                val row = habitRows(app.store.cachedHabits(owner), app.store.pendingHabits(owner), today, "monday").first { it.id == habitId }
                if (row.completed) break
                Thread.sleep(200)
            }
            assertTrue(habitRows(app.store.cachedHabits(owner), app.store.pendingHabits(owner), today, "monday").first { it.id == habitId }.completed)
            app.sync()
            assertTrue(app.store.cachedHabits(owner)!!.habits.first { it.id == habitId }.todayCompleted)
            assertTrue(app.store.pendingHabits(owner).isEmpty())
            eventually("Widget reflects confirmed check-in") { hasText("1/1 today") }
            // Queue is SQLite-backed, not a process-only flag; a fresh store reads it.
            app.habits.checkIn(owner, habitId, today, false)
            val reopened = SqliteStore(context)
            assertFalse(reopened.pendingHabits(owner).single().completed)
            reopened.close()
            app.sync()
            assertFalse(app.store.cachedHabits(owner)!!.habits.first { it.id == habitId }.todayCompleted)
            // A new account generation rejects old widget actions and cached rows.
            app.store.clear()
            app.store.ensureAccountEpoch()
            app.habits.checkIn(owner, habitId, today, true)
            assertTrue(app.store.pendingHabits(app.accountEpoch()!!).isEmpty())
            assertNull(app.store.cachedHabits(owner))
            app.sync()
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            host.deleteHost()
        }
    }
}
