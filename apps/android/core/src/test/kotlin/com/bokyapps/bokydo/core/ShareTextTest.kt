package com.bokyapps.bokydo.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShareTextTest {
    @Test
    fun nullAndBlankSharesAreNoShare() {
        assertNull(sanitizeSharedText(null))
        assertNull(sanitizeSharedText("   "))
        assertNull(sanitizeSharedText(""))
        assertNull(sanitizeSharedText("\n\n"))
    }

    @Test
    fun plainTextPassesTrimmedAndCapped() {
        assertEquals(SharedText("Call Ana", ""), sanitizeSharedText("  Call Ana\n"))
        val long = "x".repeat(SHARE_MAX_CHARS + 500)
        val share = sanitizeSharedText(long)!!
        assertEquals(SHARE_TITLE_CHARS, share.title.length)
        // The overflow is kept, as the description, rather than dropped.
        assertEquals(SHARE_MAX_CHARS - SHARE_TITLE_CHARS, share.details.length)
    }

    @Test
    fun hostileTextStaysText() {
        val hostile = "<script>alert(1)</script> javascript:alert(2) \"quoted\"; DROP TABLE tasks;"
        val share = sanitizeSharedText(hostile)
        assertEquals(SharedText(hostile, ""), share)
    }

    @Test
    fun aTypicalShareSplitsIntoTitleAndDescription() {
        val share = sanitizeSharedText("Quarterly report\nhttps://example.com/q3\nSee the annex")!!
        assertEquals("Quarterly report", share.title)
        assertEquals("https://example.com/q3\nSee the annex", share.details)
    }

    @Test
    fun controlCharactersNeverReachTheTask() {
        // The server's task content is single-line and rejects control characters, so a share
        // with them must still produce a task it accepts.
        val share = sanitizeSharedText("Call\u0000 Ana\ttomorrow\u001b[31m")!!
        assertEquals("Call  Ana tomorrow [31m", share.title)
        assertEquals("", share.details)
        val twoLines = sanitizeSharedText("First\r\nSecond\n\n  \nThird")!!
        assertEquals("First", twoLines.title)
        assertEquals("Second\nThird", twoLines.details)
    }

    @Test
    fun theTitleIsCappedAtTheServerLimit() {
        val share = sanitizeSharedText("x".repeat(1400))!!
        assertEquals(SHARE_TITLE_CHARS, share.title.length)
    }

    @Test
    fun aLeadingBlankLineIsSkipped() {
        assertEquals(SharedText("Call Ana", "Second line"), sanitizeSharedText("\n\nCall Ana\nSecond line"))
    }
}
