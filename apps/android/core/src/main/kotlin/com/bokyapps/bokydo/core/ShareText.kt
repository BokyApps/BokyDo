package com.bokyapps.bokydo.core

/** Shared text is capped like the quick-add field, so a hostile share can't blow up the sheet. */
const val SHARE_MAX_CHARS = 2000

/**
 * Shared text is untrusted: another app hands it over. Take it as plain text only (styling
 * spans are dropped by [CharSequence.toString]), cap the length, and treat blank as no share.
 * Never auto-saves: the caller still shows the quick-add sheet and the user taps Add.
 */
fun sanitizeSharedText(text: CharSequence?): String? {
    if (text == null) return null
    val plain = text.toString().trim().take(SHARE_MAX_CHARS)
    return plain.ifBlank { null }
}
