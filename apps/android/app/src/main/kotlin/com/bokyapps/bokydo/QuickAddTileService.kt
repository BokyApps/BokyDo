package com.bokyapps.bokydo

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService

/**
 * The Quick Settings tile: one tap opens the quick-add sheet. It only opens the app —
 * shared text still goes through the SEND flow, and nothing is ever saved without the
 * user tapping Add. Needs no permissions of its own.
 */
class QuickAddTileService : TileService() {
    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        super.onClick()
        val intent = Intent(this, MainActivity::class.java)
            .setAction("com.bokyapps.bokydo.QUICK_ADD")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            startActivityAndCollapse(pending)
        } else {
            // The Intent overload is deprecated but is the only one below API 34; it is never
            // reached on 34+, where it would throw, because of the version check above.
            startActivityAndCollapse(intent)
        }
    }
}
