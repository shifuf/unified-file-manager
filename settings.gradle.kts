pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

plugins {
    // 缺失 JDK 时自动下载（CI / 新机器零配置）
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        mavenCentral()
    }
}

rootProject.name = "unified-file-manager"

include(
    "server:core",
    "server:app",
    "server:worker",
    "tools:codegen",
)
