package com.bokyapps.bokydo

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import com.bokyapps.bokydo.core.MobileRelease
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.util.UUID

/** Downloads and verifies an update into private cache. Never uses the caller's session tokens. */
internal object UpdateInstaller {
    suspend fun download(context: Context, origin: String, release: MobileRelease): File = withContext(Dispatchers.IO) {
        val folder = File(context.cacheDir, "apk-updates")
        if (!folder.exists() && !folder.mkdirs()) throw IOException("Couldn't prepare update storage")
        // Installer grants can outlive the settings screen. Keep recently handed-off files,
        // then reclaim old app-owned downloads on the next attempt.
        val cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000
        folder.listFiles()?.filter { it.isFile && it.name.startsWith("update-") && it.lastModified() < cutoff }?.forEach { it.delete() }
        val apk = File(folder, "update-${UUID.randomUUID()}.apk")
        try {
            MobileRelease.download(origin, release, apk)
            withContext(Dispatchers.IO) { validateArchive(context, apk, release) }
            apk
        } catch (error: Throwable) {
            apk.delete()
            throw error
        }
    }

    /** Start the OS package installer, requesting the user's per-app install permission if needed. */
    suspend fun installOrRequestPermission(
        context: Context,
        apk: File,
        release: MobileRelease,
        accountStillCurrent: () -> Boolean,
    ): InstallResult {
        withContext(Dispatchers.IO) {
            MobileRelease.verifyDownloaded(apk, release)
            validateArchive(context, apk, release)
        }
        if (!accountStillCurrent()) throw IOException("Signed-in server changed")
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
            val intent = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            return InstallResult.PermissionRequired
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
        val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        return InstallResult.Launched
    }

    private fun validateArchive(context: Context, apk: File, release: MobileRelease) {
        val pm = context.packageManager
        val archive = packageInfo(pm, apk.absolutePath)
            ?: throw IOException("Downloaded file is not a valid Android app")
        val installed = packageInfo(pm, context.packageName)
            ?: throw IOException("Couldn't read the installed app")
        if (archive.packageName != context.packageName) throw IOException("This update is for a different app")
        if (versionCode(archive) != release.versionCode || archive.versionName != release.version) {
            throw IOException("APK version does not match the release metadata")
        }
        if (versionCode(archive) <= versionCode(installed)) throw IOException("No newer update is available")
        if (!sameSigners(installed, archive)) throw IOException("Update signing certificate does not match this app")
    }

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun packageInfo(pm: PackageManager, pathOrPackage: String): PackageInfo? = try {
        if (pathOrPackage.startsWith('/')) {
            val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
            pm.getPackageArchiveInfo(pathOrPackage, flags)
        } else {
            if (Build.VERSION.SDK_INT >= 33) {
                pm.getPackageInfo(pathOrPackage, PackageManager.PackageInfoFlags.of(
                    (if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES).toLong(),
                ))
            } else {
                pm.getPackageInfo(pathOrPackage, if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES)
            }
        }
    } catch (_: PackageManager.NameNotFoundException) {
        null
    }

    @Suppress("DEPRECATION")
    private fun sameSigners(installed: PackageInfo, archive: PackageInfo): Boolean {
        if (Build.VERSION.SDK_INT >= 28) {
            val installedSigners = installed.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
            val archiveSigners = archive.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
            return !installedSigners.isNullOrEmpty() && installedSigners == archiveSigners
        }
        val installedSigners = installed.signatures?.map { it.toCharsString() }?.toSet()
        val archiveSigners = archive.signatures?.map { it.toCharsString() }?.toSet()
        return !installedSigners.isNullOrEmpty() && installedSigners == archiveSigners
    }

    sealed interface InstallResult {
        data object PermissionRequired : InstallResult
        data object Launched : InstallResult
    }
}
