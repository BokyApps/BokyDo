package com.bokyapps.bokydo.core

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.io.FileInputStream
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Public release metadata served by `/downloads/android.json`. */
data class MobileRelease(
    val version: String,
    val versionCode: Long,
    val url: String,
    val minAndroid: String,
    val minSdk: Int,
    val sizeBytes: Long,
    val sha256: String,
) {
    /** URL after pinning it to the validated signed-in origin. */
    fun apkUrl(origin: String): String {
        val address = checkedOrigin(origin)
        return address.origin + url
    }

    companion object {
        const val METADATA_PATH = "/downloads/android.json"
        const val MAX_METADATA_BYTES = 32 * 1024
        const val MAX_APK_BYTES = 256L * 1024 * 1024

        /** Parse and validate all fields before allowing the URL to be requested. */
        fun parse(json: String): MobileRelease {
            try {
                return parseChecked(json)
            } catch (error: IOException) {
                throw error
            } catch (_: Exception) {
                throw IOException("Invalid Android update metadata")
            }
        }

        private fun parseChecked(json: String): MobileRelease {
            val obj = try { Json.parseToJsonElement(json) as? JsonObject }
            catch (_: Exception) { null }
                ?: throw IOException("Invalid Android update metadata")
            fun string(name: String): String {
                val value = obj[name]?.jsonPrimitive ?: throw IOException("Missing update metadata field: $name")
                if (!value.isString) throw IOException("Invalid update metadata field: $name")
                return value.content
            }
            fun number(name: String): Long {
                val value = obj[name]?.jsonPrimitive ?: throw IOException("Missing update metadata field: $name")
                if (value.isString) throw IOException("Invalid update metadata field: $name")
                return value.content.toLongOrNull() ?: throw IOException("Invalid update metadata field: $name")
            }

            val version = string("version")
            val code = number("versionCode")
            val path = string("url")
            val minAndroid = string("minAndroid")
            val minSdk = number("minSdk")
            val size = number("sizeBytes")
            val digest = string("sha256")
            if (version.isBlank() || version.length > 64 || version.any { it.isISOControl() } ||
                minAndroid.isBlank() || minAndroid.length > 32 || minAndroid.any { it.isISOControl() }) {
                throw IOException("Invalid update version")
            }
            if (code <= 0 || minSdk !in 1..100 || size !in 1..MAX_APK_BYTES) {
                throw IOException("Invalid Android update metadata")
            }
            if (!Regex("/downloads/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.apk").matches(path)) {
                throw IOException("Invalid Android update download path")
            }
            if (!Regex("[A-Fa-f0-9]{64}").matches(digest)) throw IOException("Invalid update checksum")
            return MobileRelease(version, code, path, minAndroid, minSdk.toInt(), size, digest.lowercase())
        }

        /** Fetches only from the validated origin, with redirects disabled and a strict size cap. */
        suspend fun fetch(origin: String, http: OkHttpClient = OkHttpClient()): MobileRelease {
            val address = checkedOrigin(origin)
            val client = http.newBuilder().followRedirects(false).followSslRedirects(false).build()
            val request = Request.Builder().url(address.origin + METADATA_PATH).get().build()
            return executeCancellable(client.newCall(request)) { response ->
                response.use {
                    if (!it.isSuccessful) throw IOException("Update check failed (${it.code})")
                    val body = it.body ?: throw IOException("Empty update metadata")
                    if (body.contentLength() > MAX_METADATA_BYTES) throw IOException("Update metadata is too large")
                    val bytes = body.byteStream().use { input ->
                        val out = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(4096)
                        var total = 0
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            total += read
                            if (total > MAX_METADATA_BYTES) throw IOException("Update metadata is too large")
                            out.write(buffer, 0, read)
                        }
                        out.toByteArray()
                    }
                    parse(bytes.toString(Charsets.UTF_8))
                }
            }
        }

        /** Download to a temporary sibling, verify exact length and SHA-256, then atomically move. */
        suspend fun download(
            origin: String,
            release: MobileRelease,
            destination: File,
            http: OkHttpClient = OkHttpClient(),
        ): File {
            val request = Request.Builder().url(release.apkUrl(origin)).get().build()
            val client = http.newBuilder().followRedirects(false).followSslRedirects(false).build()
            val call = client.newCall(request)
            val partial = File(destination.parentFile ?: throw IOException("Invalid update destination"), destination.name + ".${UUID.randomUUID()}.part")
            if (partial.parentFile?.exists() != true && partial.parentFile?.mkdirs() != true) {
                throw IOException("Couldn't prepare update storage")
            }
            partial.delete()
            return executeCancellable(call, onCancel = { partial.delete(); destination.delete() }) { response ->
                try {
                    response.use {
                        if (!it.isSuccessful) throw IOException("APK download failed (${it.code})")
                        val body = it.body ?: throw IOException("Empty APK download")
                        val length = body.contentLength()
                        if (length != -1L && length != release.sizeBytes) throw IOException("APK size does not match release metadata")
                        if (length > MAX_APK_BYTES) throw IOException("APK is too large")
                        val digest = MessageDigest.getInstance("SHA-256")
                        var written = 0L
                        body.byteStream().use { input ->
                            partial.outputStream().buffered().use { output ->
                                val buffer = ByteArray(32 * 1024)
                                while (true) {
                                    val count = input.read(buffer)
                                    if (count < 0) break
                                    written += count
                                    if (written > release.sizeBytes || written > MAX_APK_BYTES) throw IOException("APK is larger than expected")
                                    digest.update(buffer, 0, count)
                                    output.write(buffer, 0, count)
                                }
                            }
                        }
                        if (written != release.sizeBytes) throw IOException("APK size does not match release metadata")
                        val actual = digest.digest().joinToString("") { "%02x".format(it) }
                        if (!actual.equals(release.sha256, ignoreCase = true)) throw IOException("APK checksum does not match")
                    }
                    if (destination.exists() && !destination.delete()) throw IOException("Couldn't replace cached update")
                    if (!partial.renameTo(destination)) throw IOException("Couldn't finish saving the update")
                    destination
                } catch (error: Throwable) {
                    partial.delete()
                    throw error
                }
            }
        }

        /** Recheck a cached download immediately before handing it to Android's installer. */
        fun verifyDownloaded(file: File, release: MobileRelease) {
            if (!file.isFile || file.length() != release.sizeBytes || file.length() > MAX_APK_BYTES) {
                throw IOException("APK size does not match release metadata")
            }
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { input ->
                val buffer = ByteArray(32 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actual.equals(release.sha256, ignoreCase = true)) throw IOException("APK checksum does not match")
        }

        private suspend fun <T> executeCancellable(call: Call, onCancel: () -> Unit = {}, consume: (Response) -> T): T =
            suspendCancellableCoroutine { continuation ->
                continuation.invokeOnCancellation { call.cancel(); onCancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, error: IOException) {
                        onCancel()
                        if (continuation.isActive) continuation.resumeWithException(error)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        if (!continuation.isActive) {
                            response.close()
                            onCancel()
                            return
                        }
                        try {
                            val value = consume(response)
                            if (continuation.isActive) continuation.resume(value)
                            else onCancel()
                        } catch (error: Throwable) {
                            onCancel()
                            if (continuation.isActive) continuation.resumeWithException(error)
                        }
                    }
                })
            }

        private fun checkedOrigin(origin: String): ServerAddress = when (val parsed = ServerAddress.parse(origin)) {
            is ServerAddress.Result.Ok -> {
                if (parsed.address.origin != origin.trimEnd('/')) throw IOException("Invalid server origin")
                parsed.address
            }
            is ServerAddress.Result.Invalid -> throw IOException(parsed.reason)
        }
    }
}
