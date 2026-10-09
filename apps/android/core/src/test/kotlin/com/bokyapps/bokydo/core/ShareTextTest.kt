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
    }

    @Test
    fun plainTextPassesTrimmedAndCapped() {
        assertEquals("Call Ana", sanitizeSharedText("  Call Ana\n"))
        val long = "x".repeat(SHARE_MAX_CHARS + 500)
        assertEquals(SHARE_MAX_CHARS, sanitizeSharedText(long)?.length)
    }

    @Test
    fun hostileTextStaysText() {
        val hostile = "<script>alert(1)</script> javascript:alert(2) \"quoted\"; DROP TABLE tasks;"
        assertEquals(hostile, sanitizeSharedText(hostile))
    }
}
