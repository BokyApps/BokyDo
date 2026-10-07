package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class WebPushTest {
    // RFC 8291 Appendix A: published example values, not secrets.
    private val vector = WebPushKeys(
        privateScalar = unb64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"), // gitleaks:allow
        publicKey = unb64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"), // gitleaks:allow
        authSecret = unb64("BTBZMqHH6r4Tts7J_aSIgg"), // gitleaks:allow
    )
    private val body = unb64(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
            "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
            "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    )

    @Test fun decryptsTheRfcExample() {
        assertEquals("When I grow up, I want to be a watermelon", String(WebPush.decrypt(body, vector)))
    }

    @Test fun rejectsTamperingAndOtherKeys() {
        for (i in listOf(0, 20, 30, 90, body.size - 1)) {
            val bad = body.copyOf().also { it[i] = (it[i].toInt() xor 1).toByte() }
            try {
                WebPush.decrypt(bad, vector)
                fail("tampered byte $i accepted")
            } catch (_: WebPushException) {
            }
        }
        val other = WebPushKeys.generate()
        try {
            WebPush.decrypt(body, other)
            fail("decrypted with someone else's keys")
        } catch (_: WebPushException) {
        }
        // A sender "key" that isn't on the curve.
        val offCurve = body.copyOf().also { b -> for (i in 22 until 86) b[i] = 1 }
        try {
            WebPush.decrypt(offCurve, vector)
            fail("off-curve key accepted")
        } catch (_: WebPushException) {
        }
        try {
            WebPush.decrypt(body.copyOf(40), vector)
            fail("truncated message accepted")
        } catch (_: WebPushException) {
        }
    }

    @Test fun roundTripsWithGeneratedKeys() {
        val keys = WebPushKeys.generate(SecureRandom())
        assertEquals(65, keys.publicKey.size)
        assertEquals(87, keys.p256dh.length)
        val restored = WebPushKeys.decode(keys.encode())!!
        assertArrayEquals(keys.privateScalar, restored.privateScalar)
        val message = """{"title":"Call Ana","body":"In 10 minutes","url":"/task/1","tag":"reminder:1"}"""
        assertEquals(message, String(WebPush.decrypt(encrypt(message.toByteArray(), keys), restored)))
        assertNull(WebPushKeys.decode("not.a.key"))
    }

    /** The sender side (what the server does), to test against keys this code generated. */
    private fun encrypt(plain: ByteArray, to: WebPushKeys): ByteArray {
        val sender = WebPushKeys.generate()
        val shared = KeyAgreement.getInstance("ECDH").run {
            init(WebPush.privateKey(sender.privateScalar))
            doPhase(WebPush.publicKey(to.publicKey), true)
            generateSecret()
        }
        fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, n: Int): ByteArray {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(salt, "HmacSHA256"))
            val prk = mac.doFinal(ikm)
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            return mac.doFinal(info + byteArrayOf(1)).copyOf(n)
        }
        val salt = ByteArray(16).also(SecureRandom()::nextBytes)
        val ikm = hkdf(to.authSecret, shared, "WebPush: info".toByteArray() + byteArrayOf(0) + to.publicKey + sender.publicKey, 32)
        val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm".toByteArray() + byteArrayOf(0), 16)
        val nonce = hkdf(salt, ikm, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0), 12)
        val ct = Cipher.getInstance("AES/GCM/NoPadding").run {
            // nosemgrep: kotlin.lang.security.gcm-detection.gcm-detection -- test-only sender; key and nonce come from a random salt per message
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
            doFinal(plain + byteArrayOf(2))
        }
        return salt + byteArrayOf(0, 0, 16, 0, 65) + sender.publicKey + ct
    }
}

class RemindersTest {
    private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

    private val tasks = mapOf(
        "t1" to obj("""{"id":"t1","content":"Call Ana","isCompleted":false,"due":{"date":"2026-10-08","time":"15:00","timezone":null}}"""),
        "t2" to obj("""{"id":"t2","content":"Flight","isCompleted":false,"due":{"date":"2026-10-08","time":"09:30","timezone":"Europe/Lisbon"}}"""),
        "t3" to obj("""{"id":"t3","content":"All day","isCompleted":false,"due":{"date":"2026-10-08","time":null,"timezone":null}}"""),
        "t4" to obj("""{"id":"t4","content":"Done","isCompleted":true,"due":{"date":"2026-10-08","time":"10:00","timezone":null}}"""),
    )
    private fun relative(id: String, task: String, minutes: Int) =
        obj("""{"id":"$id","taskId":"$task","type":"relative","minutesBefore":$minutes,"date":null,"time":null,"timeZone":null}""")
    private fun absolute(id: String, task: String, date: String, time: String, zone: String?) =
        obj("""{"id":"$id","taskId":"$task","type":"absolute","minutesBefore":null,"date":"$date","time":"$time","timeZone":${zone?.let { "\"$it\"" } ?: "null"}}""")

    private fun at(iso: String) = java.time.Instant.parse(iso).toEpochMilli()

    @Test fun followsTheServersRules() {
        val schedule = Reminders.schedule(
            listOf(
                relative("r1", "t1", 30), // floating: the user's zone
                relative("r2", "t2", 0), // fixed to the task's zone
                relative("r3", "t3", 10), // no due time: inactive
                relative("r4", "t4", 0), // completed: never
                absolute("r5", "t3", "2026-10-08", "08:00", null), // absolute, user's zone
                absolute("r6", "t3", "2026-10-08", "08:00", "America/New_York"),
                relative("r7", "missing", 5), // task not visible any more
            ),
            tasks,
            "Asia/Phnom_Penh",
        )
        assertEquals(
            listOf(
                "r5" to at("2026-10-08T01:00:00Z"),
                "r2" to at("2026-10-08T08:30:00Z"),
                "r6" to at("2026-10-08T12:00:00Z"),
                "r1" to at("2026-10-08T07:30:00Z"),
            ).sortedBy { it.second },
            schedule.map { it.reminderId to it.fireAt },
        )
        assertEquals("Call Ana", schedule.first { it.reminderId == "r1" }.title)
    }

    @Test fun handlesDaylightSavingLikeTheServer() {
        // Values checked against the server's zonedInstant. On 2026-03-29 Lisbon jumps from 01:00
        // to 02:00 local: 01:30 doesn't exist and moves forward by the gap, to 02:30 summer time.
        assertEquals(at("2026-03-29T00:30:00Z"), Reminders.zonedInstant("2026-03-29", "00:30", "Europe/Lisbon"))
        assertEquals(at("2026-03-29T01:30:00Z"), Reminders.zonedInstant("2026-03-29", "01:30", "Europe/Lisbon"))
        assertEquals(at("2026-03-29T01:30:00Z"), Reminders.zonedInstant("2026-03-29", "02:30", "Europe/Lisbon"))
        // 2026-10-25 01:30 happens twice: the first occurrence (summer time).
        assertEquals(at("2026-10-25T00:30:00Z"), Reminders.zonedInstant("2026-10-25", "01:30", "Europe/Lisbon"))
        // Unknown zones count as UTC; garbage is ignored.
        assertEquals(at("2026-10-08T09:00:00Z"), Reminders.zonedInstant("2026-10-08", "09:00", "Mars/Olympus"))
        assertNull(Reminders.zonedInstant("2026-13-40", "09:00", "UTC"))
    }

    @Test fun showsEachOnceAndNotTooLate() {
        val all = Reminders.schedule(
            listOf(relative("a", "t1", 60), relative("b", "t1", 30), relative("c", "t1", 0)),
            tasks,
            "UTC",
        )
        val now = at("2026-10-08T14:40:00Z")
        val due = Reminders.due(all, emptySet(), now)
        assertEquals(listOf("a", "b"), due.map { it.reminderId })
        assertEquals(listOf("b"), Reminders.due(all, setOf(due[0].key), now).map { it.reminderId })
        assertEquals(at("2026-10-08T15:00:00Z"), Reminders.next(all, emptySet(), now))
        assertTrue(Reminders.due(all, emptySet(), at("2026-10-09T15:00:01Z")).isEmpty())
        assertNull(Reminders.next(all, emptySet(), at("2026-10-09T00:00:00Z")))
        // Moving the due time makes a new key, so the reminder can go off again.
        assertNotNull(all.first().key.substringAfter('@').toLongOrNull())
    }
}
