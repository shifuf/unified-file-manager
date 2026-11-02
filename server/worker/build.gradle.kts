plugins {
    alias(libs.plugins.spring.boot)
}

description = "Worker 启动模块（profile: worker，与 API 共用 core）"

dependencies {
    implementation(project(":server:core"))

    implementation(libs.spring.boot.starter.actuator)

    testImplementation(libs.spring.boot.starter.test)
}

tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName = "ufm-worker.jar"
}
