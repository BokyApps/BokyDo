package com.bokyapps.bokydo.core

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException
import java.security.MessageDigest
import java.nio.file.Files

class MobileReleaseTest {
    private val payload = "a small release APK fixture".toByteArray()
    private val digest = MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) }

    private fun metadata(
        url: String = "/downloads/bokydo-0.1.4.apk",
        sizeBytes: Int = 1024,
        sha256: String = digest,
    ) = """{"version":"0.1.4","versionCode":5,"url":"$url","minAndroid":"8.0","minSdk":26,"sizeBytes":$sizeBytes,"sha256":"$sha256"}"""

    @Test fun parsesReleaseAndPinsApkToValidatedOrigin() {
        val release = MobileRelease.parse(metadata())
        assertEquals("0.1.4", release.version)
        assertEquals(5L, release.versionCode)
        assertEquals("8.0", release.minAndroid)
        assertEquals(26, release.minSdk)
        assertEquals("https://tasks.example.com/downloads/bokydo-0.1.4.apk", release.apkUrl("https://tasks.example.com"))
    }

    @Test fun rejectsMissingOrInvalidFieldsAndUnsafePaths() {
        for (json in listOf(
            metadata().replace("\"versionCode\":5,", ""),
            "[]",
            "{\"version\":[],\"versionCode\":5}",
            metadata().replace("\"versionCode\":5", "\"versionCode\":\"5\""),
            metadata(url = "https://evil.example/app.apk"),
            metadata(url = "/downloads/../app.apk"),
            metadata(sizeBytes = 0),
            metadata(sha256 = "nope"),
            metadata().replace("\"versionCode\":5", "\"versionCode\":0"),
        )) assertThrows(IOException::class.java) { MobileRelease.parse(json) }
        assertThrows(IOException::class.java) {
            MobileRelease.parse(metadata()).apkUrl("https://tasks.example.com/path")
        }
    }

    @Test fun fetchUsesSameOriginEndpointAndRejectsRedirects() = runBlocking<Unit> {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setBody(metadata()))
            val origin = server.url("/").toString().trimEnd('/')
            val release = MobileRelease.fetch(origin)
            assertEquals("0.1.4", release.version)
            val request = server.takeRequest()
            assertEquals("/downloads/android.json", request.path)
            assertNull(request.getHeader("Authorization"))

            server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", "https://evil.example/meta.json"))
            assertThrows(IOException::class.java) { runBlocking { MobileRelease.fetch(origin) } }
            assertEquals("/downloads/android.json", server.takeRequest().path)
        } finally {
            server.shutdown()
        }
    }

    @Test fun rejectsOversizedMetadataEvenWithoutUsefulLength() = runBlocking<Unit> {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setBody(" ".repeat(MobileRelease.MAX_METADATA_BYTES + 1)).removeHeader("Content-Length"))
            val origin = server.url("/").toString().trimEnd('/')
            assertThrows(IOException::class.java) { runBlocking { MobileRelease.fetch(origin, OkHttpClient()) } }
        } finally {
            server.shutdown()
        }
    }

    @Test fun downloadsOnlyWhenLengthAndChecksumMatch() = runBlocking<Unit> {
        val server = MockWebServer()
        val folder = Files.createTempDirectory("mobile-release-test").toFile()
        server.start()
        try {
            val origin = server.url("/").toString().trimEnd('/')
            val release = MobileRelease.parse(metadata(sizeBytes = payload.size))
            val output = folder.resolve("release.apk")
            server.enqueue(MockResponse().setBody(payload.toString(Charsets.UTF_8)))
            assertEquals(output, MobileRelease.download(origin, release, output))
            assertEquals(payload.toList(), output.readBytes().toList())

            server.enqueue(MockResponse().setBody("wrong file"))
            assertThrows(IOException::class.java) { runBlocking { MobileRelease.download(origin, release, folder.resolve("bad.apk")) } }
            assertFalse(folder.resolve("bad.apk").exists())
            assertFalse(folder.listFiles()!!.any { it.name.endsWith(".part") })

            server.enqueue(MockResponse().setBody("x".repeat(payload.size)))
            val checksumError = assertThrows(IOException::class.java) {
                runBlocking { MobileRelease.download(origin, release, folder.resolve("wrong-checksum.apk")) }
            }
            assertEquals("APK checksum does not match", checksumError.message)
            assertFalse(folder.resolve("wrong-checksum.apk").exists())

            output.writeBytes("y".repeat(payload.size).toByteArray())
            assertThrows(IOException::class.java) { MobileRelease.verifyDownloaded(output, release) }
        } finally {
            server.shutdown()
            folder.deleteRecursively()
        }
    }

    @Test fun cancellingDownloadCancelsTheHttpCallAndLeavesNoPartialFile() = runBlocking<Unit> {
        val server = MockWebServer()
        val folder = Files.createTempDirectory("mobile-release-cancel").toFile()
        server.start()
        try {
            val origin = server.url("/").toString().trimEnd('/')
            val bytes = ByteArray(64 * 1024) { 1 }
            val release = MobileRelease.parse(metadata(sizeBytes = bytes.size, sha256 = "b".repeat(64)))
            val output = folder.resolve("cancel.apk")
            server.enqueue(MockResponse().setBody(bytes.toString(Charsets.ISO_8859_1)).throttleBody(1024, 100, java.util.concurrent.TimeUnit.MILLISECONDS))
            val job = launch { MobileRelease.download(origin, release, output) }
            delay(200)
            job.cancelAndJoin()
            assertFalse(output.exists())
            assertFalse(folder.listFiles()!!.any { it.name.endsWith(".part") })
        } finally {
            server.shutdown()
            folder.deleteRecursively()
        }
    }
}
