plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.cristidoesspam.serverpanel"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.cristidoesspam.serverpanel"
        minSdk = 29
        targetSdk = 35
        versionCode = 5
        versionName = "3.2"
        buildConfigField("String", "DEFAULT_SERVERS", "\"${project.findProperty("defaultServers") ?: ""}\"")
    }
    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        checkReleaseBuilds = false
    }
}
