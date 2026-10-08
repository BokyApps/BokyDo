package com.bokyapps.bokydo.core

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The receiving side of Web Push message encryption (RFC 8291, aes128gcm per RFC 8188), so the
 * app can read what the server sends through a UnifiedPush distributor. Only this device holds
 * the private key; the distributor and the push server only ever see ciphertext.
 */
class WebPushKeys(
    /** The P-256 private scalar (32 bytes). */
    val privateScalar: ByteArray,
    /** The uncompressed public point (65 bytes, 0x04 ‖ X ‖ Y): the subscription's `p256dh`. */
    val publicKey: ByteArray,
    /** The 16-byte authentication secret: the subscription's `auth`. */
    val authSecret: ByteArray,
) {
    val p256dh: String get() = b64(publicKey)
    val auth: String get() = b64(authSecret)

    /** For storage in the vault. */
    fun encode(): String = listOf(privateScalar, publicKey, authSecret).joinToString(".") { b64(it) }

    companion object {
        fun generate(random: SecureRandom = SecureRandom()): WebPushKeys {
            val gen = KeyPairGenerator.getInstance("EC")
            gen.initialize(ECGenParameterSpec("secp256r1"), random)
            val pair = gen.generateKeyPair()
            val d = (pair.private as java.security.interfaces.ECPrivateKey).s
            return WebPushKeys(unsigned32(d), uncompressed(pair.public as ECPublicKey), ByteArray(16).also(random::nextBytes))
        }

        fun decode(s: String): WebPushKeys? = runCatching {
            val (d, pub, auth) = s.split('.').map { unb64(it) }
            require(d.size == 32 && pub.size == 65 && pub[0] == 4.toByte() && auth.size == 16)
            WebPushKeys(d, pub, auth)
        }.getOrNull()
    }
}

class WebPushException(message: String) : Exception(message)

object WebPush {
    private const val TAG = 16
    private const val HEADER = 16 + 4 + 1

    /**
     * Decrypt one push message. Throws [WebPushException] for anything malformed or not
     * encrypted to these keys (a forged or replayed message from another sender fails the GCM tag).
     */
    fun decrypt(body: ByteArray, keys: WebPushKeys): ByteArray {
        if (body.size < HEADER + 65 + TAG + 1) throw WebPushException("too short")
        val salt = body.copyOfRange(0, 16)
        val rs = ((body[16].toInt() and 0xff) shl 24) or ((body[17].toInt() and 0xff) shl 16) or
            ((body[18].toInt() and 0xff) shl 8) or (body[19].toInt() and 0xff)
        val idLen = body[20].toInt() and 0xff
        if (idLen != 65 || rs < 18) throw WebPushException("bad header")
        val senderPublic = body.copyOfRange(HEADER, HEADER + 65)
        val ciphertext = body.copyOfRange(HEADER + 65, body.size)
        // One record only: what the server sends always fits (RFC 8291 §4 recommends it).
        if (ciphertext.size > rs) throw WebPushException("more than one record")

        val shared = try {
            KeyAgreement.getInstance("ECDH").run {
                init(privateKey(keys.privateScalar))
                doPhase(publicKey(senderPublic), true)
                generateSecret()
            }
        } catch (e: Exception) {
            throw WebPushException("bad sender key")
        }
        val keyInfo = "WebPush: info".toByteArray() + byteArrayOf(0) + keys.publicKey + senderPublic
        val ikm = hkdf(keys.authSecret, shared, keyInfo, 32)
        val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm".toByteArray() + byteArrayOf(0), 16)
        val nonce = hkdf(salt, ikm, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0), 12)
        val padded = try {
            // nosemgrep: kotlin.lang.security.gcm-detection.gcm-detection -- decrypting; RFC 8291 derives a fresh key and nonce from each message's random salt
            Cipher.getInstance("AES/GCM/NoPadding").run {
                // nosemgrep: kotlin.lang.security.gcm-detection.gcm-detection -- as above: decrypting with the per-message nonce
                init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
                doFinal(ciphertext)
            }
        } catch (e: Exception) {
            throw WebPushException("not for this device")
        }
        // Strip the padding: trailing zeros, then the last-record delimiter (2).
        var end = padded.size - 1
        while (end >= 0 && padded[end] == 0.toByte()) end--
        if (end < 0 || padded[end] != 2.toByte()) throw WebPushException("bad padding")
        return padded.copyOfRange(0, end)
    }

    private fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        return mac.doFinal(info + byteArrayOf(1)).copyOf(length)
    }

    private val params: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp256r1"))
            getParameterSpec(ECParameterSpec::class.java)
        }
    }

    internal fun privateKey(scalar: ByteArray) =
        KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, scalar), params))

    internal fun publicKey(point: ByteArray): ECPublicKey {
        if (point.size != 65 || point[0] != 4.toByte()) throw WebPushException("bad public key")
        val x = BigInteger(1, point.copyOfRange(1, 33))
        val y = BigInteger(1, point.copyOfRange(33, 65))
        // KeyFactory checks the point is on the curve (no invalid-curve attacks).
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params)) as ECPublicKey
    }
}

internal fun b64(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
internal fun unb64(s: String): ByteArray = Base64.getUrlDecoder().decode(s)

private fun unsigned32(n: BigInteger): ByteArray {
    val raw = n.toByteArray()
    return when {
        raw.size == 32 -> raw
        raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
        else -> ByteArray(32 - raw.size) + raw
    }
}

private fun uncompressed(key: ECPublicKey): ByteArray =
    byteArrayOf(4) + unsigned32(key.w.affineX) + unsigned32(key.w.affineY)
