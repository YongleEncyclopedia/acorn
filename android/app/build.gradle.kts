import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The app carries the project's version: "version" in the root package.json (0.2.0 → versionName 0.2.0,
// versionCode 200), so a v0.2.0 tag builds the APK and the desktop installers of the same release.
val appVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(rootDir.resolve("../package.json").readText())!!.groupValues[1]
val appVersionCode: Int = appVersion.substringBefore('-').split('.').map { it.toInt() }
    .let { (major, minor, patch) -> major * 10000 + minor * 100 + patch }

// Release signing key, from the environment (the workflow fills these from repository secrets). Without one the
// release build is signed with the debug key: it installs fine, but an APK signed with another key can only
// replace it after an uninstall. See "安卓手机" in the README.
val keystore: File? = System.getenv("ACORN_KEYSTORE")?.takeIf { it.isNotBlank() }?.let(::file)?.takeIf { it.isFile }

android {
    namespace = "io.github.yongleencyclopedia.acorn"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.yongleencyclopedia.acorn"
        minSdk = 26
        // Newer target SDKs bring Android's local-network permission, and this app's whole job is to reach a
        // computer on the LAN: handle that before raising it.
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
    }

    lint {
        // Google Play's target-SDK deadline: lint makes it fatal for release builds, but this APK is not on Play
        disable += "ExpiredTargetSdkVersion"
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = keystore
                storePassword = System.getenv("ACORN_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ACORN_KEY_ALIAS")
                keyPassword = System.getenv("ACORN_KEY_PASSWORD")?.takeIf { it.isNotEmpty() } ?: System.getenv("ACORN_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (keystore != null) "release" else "debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    // QR codes: the sign-in code the computer shows. Pure Java, so it also works on phones without Google services.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
}
