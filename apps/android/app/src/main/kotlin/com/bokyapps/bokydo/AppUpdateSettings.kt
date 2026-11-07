package com.bokyapps.bokydo

import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.bokyapps.bokydo.core.MobileRelease
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.File

/** Settings card for checking and installing a signed update published by the signed-in server. */
@Composable
fun AppUpdateSettings() {
    val context = LocalContext.current
    val app = context.app
    val session = app.sessions.load()
    val origin = session?.origin
    val accountEpoch = app.accountEpoch()
    key(origin, accountEpoch) { AppUpdateSettingsContent(origin, accountEpoch) }
}

@Composable
private fun AppUpdateSettingsContent(origin: String?, accountEpoch: String?) {
    val context = LocalContext.current
    val app = context.app
    val scope = rememberCoroutineScope()
    var retry by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var release by remember { mutableStateOf<MobileRelease?>(null) }
    var cachedApk by remember { mutableStateOf<File?>(null) }
    var handedToInstaller by remember { mutableStateOf(false) }
    DisposableEffect(Unit) {
        onDispose { if (!handedToInstaller) cachedApk?.delete() }
    }
    var message by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(origin, accountEpoch, retry) {
        release = null
        if (!handedToInstaller) cachedApk?.delete()
        cachedApk = null
        handedToInstaller = false
        if (origin == null) {
            message = "Sign in to a BokyDo server to check for updates."
            return@LaunchedEffect
        }
        busy = true
        message = "Checking for updates…"
        try {
            val found = MobileRelease.fetch(origin)
            val installed = installedVersion(context)
            when {
                found.minSdk > Build.VERSION.SDK_INT -> message = "Update ${found.version} requires Android ${found.minAndroid} or later."
                found.versionCode <= installed -> message = "Up to date"
                else -> {
                    release = found
                    message = "Update available: ${found.version}"
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            message = "Couldn't check for an update. Check your connection and try again."
        } finally {
            busy = false
        }
    }

    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("App updates", style = MaterialTheme.typography.titleMedium)
        Text(message ?: "Checking for updates…", style = MaterialTheme.typography.bodyMedium)
        if (busy) CircularProgressIndicator()
        val offered = release
        if (!busy && offered != null) {
            Button(onClick = {
                if (!accountIsCurrent(app, origin, accountEpoch)) {
                    message = "The signed-in server changed. Check for updates again."
                    release = null
                    return@Button
                }
                val existing = cachedApk
                scope.launch {
                    busy = true
                    try {
                        if (existing != null && existing.exists()) {
                            val result = UpdateInstaller.installOrRequestPermission(context, existing, offered) {
                                accountIsCurrent(app, origin, accountEpoch)
                            }
                            handedToInstaller = result == UpdateInstaller.InstallResult.Launched
                            message = if (result == UpdateInstaller.InstallResult.PermissionRequired) {
                                "Allow installs from BokyDo in Android settings, then tap Install update."
                            } else "Android's installer opened. Your app data stays on this device."
                        } else {
                            message = "Downloading and verifying update…"
                            val apk = UpdateInstaller.download(context, origin!!, offered)
                            if (!accountIsCurrent(app, origin, accountEpoch)) {
                                apk.delete()
                                throw IllegalStateException("Signed-in server changed during download")
                            }
                            cachedApk = apk
                            handedToInstaller = false
                            message = "Update downloaded and verified. Your app data stays on this device."
                        }
                    } catch (cancelled: CancellationException) {
                        cachedApk?.delete()
                        cachedApk = null
                        throw cancelled
                    } catch (_: Exception) {
                        cachedApk?.delete()
                        cachedApk = null
                        message = "Couldn't download or verify the update. Try again."
                    } finally {
                        busy = false
                    }
                }
            }) { Text(if (cachedApk?.exists() == true) "Install update" else "Download update") }
        }
        if (!busy) OutlinedButton(onClick = { retry++ }) { Text("Check for updates") }
    }
}

private fun accountIsCurrent(app: BokyDoApp, origin: String?, accountEpoch: String?): Boolean =
    app.sessions.load()?.origin == origin && app.accountEpoch() == accountEpoch

@Suppress("DEPRECATION")
private fun installedVersion(context: android.content.Context): Long {
    val info = if (Build.VERSION.SDK_INT >= 33) {
        context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
    } else context.packageManager.getPackageInfo(context.packageName, 0)
    return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
}
