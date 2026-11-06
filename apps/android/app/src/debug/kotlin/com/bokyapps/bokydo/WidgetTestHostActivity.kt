package com.bokyapps.bokydo

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.os.Bundle
import android.widget.LinearLayout

/** Test host uses the real launcher widget protocol, never included in a release APK. */
class WidgetTestHostActivity : Activity() {
    lateinit var host: AppWidgetHost
    lateinit var content: LinearLayout
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        host = AppWidgetHost(this, 7391)
        host.startListening()
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val manager = AppWidgetManager.getInstance(this)
        for (id in intent.getIntArrayExtra("ids") ?: intArrayOf()) {
            val view = host.createView(this, id, manager.getAppWidgetInfo(id))
            content.addView(view, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (280 * resources.displayMetrics.density).toInt()))
        }
        setContentView(content)
    }
    override fun onDestroy() {
        host.stopListening()
        super.onDestroy()
    }
}
