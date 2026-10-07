package com.bokyapps.bokydo.core

import java.security.SecureRandom
import java.util.UUID

/** UUIDv7 (time-ordered, random tail), like the server and web app generate. */
object Ids {
    private val random = SecureRandom()

    fun newId(nowMs: Long = System.currentTimeMillis()): String {
        val bytes = ByteArray(16).also(random::nextBytes)
        for (i in 0 until 6) bytes[i] = (nowMs ushr (40 - 8 * i)).toByte()
        bytes[6] = ((bytes[6].toInt() and 0x0f) or 0x70).toByte()
        bytes[8] = ((bytes[8].toInt() and 0x3f) or 0x80).toByte()
        var msb = 0L
        var lsb = 0L
        for (i in 0 until 8) msb = (msb shl 8) or (bytes[i].toLong() and 0xff)
        for (i in 8 until 16) lsb = (lsb shl 8) or (bytes[i].toLong() and 0xff)
        return UUID(msb, lsb).toString()
    }
}
