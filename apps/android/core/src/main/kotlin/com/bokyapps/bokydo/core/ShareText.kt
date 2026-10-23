package com.bokyapps.bokydo.core

/**
 * A shared piece of text, split for the task it becomes: a single-line title (the server's task
 * content is `line(1000)`, which rejects newlines and control characters) and the rest as the
 * description, so nothing the sharer sent is silently thrown away.
 */
data class SharedText(val title: String, val details: String)

/** The task title limit: the server's own task content cap. */
const val SHARE_TITLE_CHARS = 1000

/** How much of a share we look at in total, before splitting it. */
const val SHARE_MAX_CHARS = 2000

// eslint-disable-next-line no-control-regex
private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")

/**
 * Shared text is untrusted: another app hands it over. Take it as plain text only (styling
 * spans are dropped by [CharSequence.toString]), then split it — the first line becomes the
 * task title (control characters folded to spaces, capped at the server's own limit) and
 * everything after it its description, so a typical "Title\nhttps://…" share becomes a task
 * the server will accept. Never auto-saves: the caller still shows the quick-add sheet and the
 * user taps Add.
 */
fun sanitizeSharedText(text: CharSequence?): SharedText? {
    if (text == null) return null
    val lines = text.toString().take(SHARE_MAX_CHARS).split('\n')
    val first = lines.indexOfFirst { clean(it).isNotEmpty() }
    if (first < 0) return null
    val head = clean(lines[first])
    val title = head.take(SHARE_TITLE_CHARS)
    // The title's own overflow, then the rest of the share, as the description.
    val overflow = if (head.length > SHARE_TITLE_CHARS) head.substring(SHARE_TITLE_CHARS) else ""
    val details = (listOf(overflow) + lines.drop(first + 1).map { clean(it) })
        .filter { it.isNotEmpty() }
        .joinToString("\n")
    return SharedText(title, details)
}

/** One line, with control characters (which the schema forbids) folded to spaces. */
private fun clean(line: String): String = line.replace(CONTROL, " ").trim()
