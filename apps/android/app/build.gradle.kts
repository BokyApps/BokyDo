plugins {
    alias(libs.plugins.android.application)
    // AGP 9 compiles Kotlin itself (built-in Kotlin): no org.jetbrains.kotlin.android plugin.
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.bokyapps.bokydo"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.bokyapps.bokydo"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            // Signing is set up in A7 (release); a local release build is unsigned.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = false
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.work.runtime)
    // Quick add runs the web's parser in the WebView's isolated V8 (ADR 0016).
    implementation(libs.androidx.javascriptengine)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    // Ramble's mic glyph lives in the extended set (BOM pins the version).
    implementation(libs.androidx.compose.material.icons.extended)
}
