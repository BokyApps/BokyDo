package com.bokyapps.bokydo

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.bokyapps.bokydo.core.Json
import com.bokyapps.bokydo.core.PendingAuth
import com.bokyapps.bokydo.core.Session
import com.bokyapps.bokydo.core.SessionStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small secrets (the session's tokens, an in-progress sign-in) encrypted with AES-256-GCM under
 * a key that lives in the Android Keystore: it can't be exported, so a copy of the app's files
 * (backup, rooted-device dump of /data) is useless without this device's secure hardware. The
 * key needs no user authentication, so background sync keeps working; the optional app lock
 * (A2) gates the UI instead. Each value is bound to its name as associated data.
 */
class Vault(context: Context) {
    private val prefs = context.getSharedPreferences("vault", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return gen.generateKey()
    }

    @Synchronized
    fun put(name: String, plaintext: String?) {
        if (plaintext == null) {
            prefs.edit().remove(name).commit()
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        cipher.updateAAD("bokydo:$name".toByteArray())
        val ct = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val stored = Base64.encodeToString(cipher.iv, B64) + "." + Base64.encodeToString(ct, B64)
        prefs.edit().putString(name, stored).commit()
    }

    /** null when absent or undecryptable (e.g. the Keystore key was wiped): treated as signed out. */
    @Synchronized
    fun get(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        return runCatching {
            val (iv, ct) = stored.split('.').let { Base64.decode(it[0], B64) to Base64.decode(it[1], B64) }
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                // nosemgrep: kotlin.lang.security.gcm-detection.gcm-detection -- decrypting with the stored IV; encryption IVs are Keystore-random (setRandomizedEncryptionRequired)
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            }
            cipher.updateAAD("bokydo:$name".toByteArray())
            String(cipher.doFinal(ct), Charsets.UTF_8)
        }.getOrElse {
            prefs.edit().remove(name).commit()
            null
        }
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "bokydo.vault.v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val B64 = Base64.NO_WRAP or Base64.URL_SAFE
    }
}

/** The signed-in session, in the [Vault], cached in memory after the first read. */
class VaultSessionStore(private val vault: Vault) : SessionStore {
    @Volatile private var cached: Session? = null
    @Volatile private var loaded = false

    override fun load(): Session? {
        if (!loaded) {
            cached = vault.get("session")?.let { runCatching { Json.decodeFromString(Session.serializer(), it) }.getOrNull() }
            loaded = true
        }
        return cached
    }

    override fun save(session: Session) {
        vault.put("session", Json.encodeToString(Session.serializer(), session))
        cached = session
        loaded = true
    }

    override fun clear() {
        vault.put("session", null)
        cached = null
        loaded = true
    }
}

/** The sign-in in progress (state + PKCE verifier). Taken exactly once, by the redirect. */
class PendingAuthStore(private val vault: Vault) {
    fun put(pending: PendingAuth) = vault.put("pending-auth", Json.encodeToString(PendingAuth.serializer(), pending))

    fun take(): PendingAuth? {
        val raw = vault.get("pending-auth") ?: return null
        vault.put("pending-auth", null)
        return runCatching { Json.decodeFromString(PendingAuth.serializer(), raw) }.getOrNull()
    }

    fun clear() = vault.put("pending-auth", null)
}
