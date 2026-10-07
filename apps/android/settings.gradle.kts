pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "BokyDo"

// :core is plain Kotlin/JVM (protocol, sign-in and sync logic), testable with no Android SDK.
// :app needs an SDK with an installed platform (local.properties sdk.dir or ANDROID_HOME).
include(":core")
val localProps = java.util.Properties().apply {
    val f = file("local.properties")
    if (f.isFile) f.inputStream().use { load(it) }
}
val sdk = localProps.getProperty("sdk.dir") ?: System.getenv("ANDROID_HOME")
if (sdk != null && java.io.File(sdk, "platforms").listFiles()?.isNotEmpty() == true) {
    include(":app")
} else {
    logger.lifecycle("BokyDo: no Android SDK found (sdk.dir / ANDROID_HOME): only :core is configured.")
}
