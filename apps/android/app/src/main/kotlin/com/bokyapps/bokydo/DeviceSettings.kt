package com.bokyapps.bokydo

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The settings that belong to this phone rather than to the account: Material You's dynamic
 * colour (it follows the wallpaper, so it cannot sync) and the time zone we last offered to
 * switch to (the travel prompt is offered once per zone).
 */
class DeviceSettings(context: Context) {
    private val prefs = context.getSharedPreferences("bokydo.device", Context.MODE_PRIVATE)

    private val _dynamicColor = MutableStateFlow(prefs.getBoolean("dynamicColor", false))

    /** Whether the colours follow the phone's wallpaper (Android 12 and later). */
    val dynamicColor: StateFlow<Boolean> = _dynamicColor

    fun setDynamicColor(on: Boolean) {
        prefs.edit().putBoolean("dynamicColor", on).apply()
        _dynamicColor.value = on
    }

    /** The zone the travel prompt was last shown for. */
    var lastOfferedZone: String?
        get() = prefs.getString("offeredZone", null)
        set(value) = prefs.edit().putString("offeredZone", value).apply()
}
