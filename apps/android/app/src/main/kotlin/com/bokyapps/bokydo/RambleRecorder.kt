package com.bokyapps.bokydo

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * Delete recordings a previous process left behind: a recording in progress when the app was
 * killed never gets to `stop()`, so without this its file sits in `cacheDir` until the OS
 * reclaims it (and holds whatever was captured). Safe to call at any time: nothing live uses
 * these names, and a finished recording is deleted by its own owner.
 */
fun sweepOrphanedRecordings(context: Context) {
    cacheDir(context).listFiles { f -> f.name.startsWith(PREFIX) && f.name.endsWith(".m4a") }
        ?.forEach { it.delete() }
}

/** One voice chunk, recorded on the device and sent to the server for transcription. */
sealed interface Recording {
    data class Done(val file: File, val seconds: Double) : Recording
    /** Nothing usable was captured (too short, interrupted, or the mic failed). */
    data class Failed(val reason: String) : Recording
}

/**
 * A single Ramble recording: AAC in an MP4 container (the server's STT takes audio uploads),
 * capped at 60 s so a chunk always fits the server's transcription limits. The caller owns
 * the returned file and deletes it after uploading. Must be stopped and released even when
 * the screen goes away mid-recording.
 */
private const val PREFIX = "ramble-"

class RambleRecorder(context: Context) {
    private val file = File(cacheDir(context), "$PREFIX${System.currentTimeMillis()}.m4a")
    private val startedAt = System.currentTimeMillis()
    private var recorder: MediaRecorder? = runCatching {
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else MediaRecorder()).apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            setAudioEncodingBitRate(128_000)
            setAudioSamplingRate(44_100)
            setMaxDuration(60_000)
            setOutputFile(file.absolutePath)
            prepare()
            start()
        }
    }.getOrNull()

    val running: Boolean get() = recorder != null

    /** Stop and hand over the file, or a reason when nothing usable was captured. */
    fun stop(): Recording {
        val r = recorder
        recorder = null
        val seconds = (System.currentTimeMillis() - startedAt) / 1000.0
        if (r == null) {
            file.delete()
            return Recording.Failed("Couldn't start the microphone.")
        }
        runCatching { r.stop() }
        runCatching { r.release() }
        return if (seconds < 0.5 || !file.exists() || file.length() == 0L) {
            file.delete()
            Recording.Failed("Nothing was recorded. Hold the phone closer and try again.")
        } else {
            Recording.Done(file, seconds.coerceAtMost(60.0))
        }
    }

    /** Give up: stop the mic and throw the file away. */
    fun cancel() {
        val r = recorder
        recorder = null
        runCatching { r?.stop() }
        runCatching { r?.release() }
        file.delete()
    }
}

private fun cacheDir(context: Context): File = context.cacheDir
