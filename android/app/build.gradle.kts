plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.talha.mpvcompanion"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.talha.mpvcompanion"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt")
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// Gereksiz hiçbir harici SDK veya üçüncü parti bağımlılık eklenmemiştir.
// Yalnızca Android SDK'nın kendi yerleşik (framework) sınıfları kullanılır.
dependencies {}
