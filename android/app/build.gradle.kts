import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.tmuxifier.console"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.tmuxifier.console"
        minSdk = 26
        targetSdk = 35
        versionCode = 18
        versionName = "1.1.3"
    }
    // Release signing only when the operator's keystore exists (same
    // conditional posture as the Firebase config below): the public repo
    // builds an unsigned release without it.
    val ksProps = rootProject.file("keystore.properties")
    signingConfigs {
        if (ksProps.exists()) {
            create("release") {
                val p = Properties().apply { ksProps.inputStream().use { s -> load(s) } }
                storeFile = rootProject.file(p.getProperty("storeFile"))
                storePassword = p.getProperty("storePassword")
                keyAlias = p.getProperty("keyAlias")
                keyPassword = p.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (ksProps.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true // Settings shows VERSION_NAME so device-validation rounds are unambiguous
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.core:core-ktx:1.15.0")
    // Not used directly (no fragments) — pins the transitive fragment above
    // 1.3.0 so the ActivityResult lint-vital check passes on release builds.
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    testImplementation("org.jetbrains.kotlin:kotlin-test:2.1.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

// No google-services plugin, deliberately: Firebase initializes at RUNTIME
// from the client config the operator's server serves (GET
// /api/devices/fcm-config, backed by TMUXIFIER_FCM_APP_CONFIG). One published
// APK works against any operator's Firebase project — nothing is baked in.
