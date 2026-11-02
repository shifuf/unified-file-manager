plugins {
    alias(libs.plugins.spring.boot)
}

description = "API 启动模块（profile: api）"

dependencies {
    implementation(project(":server:core"))

    implementation(libs.spring.boot.starter.actuator)
    implementation(libs.springdoc.openapi)

    testImplementation(libs.spring.boot.starter.test)
    testImplementation(libs.testcontainers.postgresql)
}

tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName = "ufm-api.jar"
}

tasks.named<Test>("test") {
    // OpenApiContractTest 把契约写到 build/openapi/openapi.json，供 CI 生成 TS 类型。
    systemProperty(
        "ufm.openapi.output",
        layout.buildDirectory.file("openapi/openapi.json").get().asFile.absolutePath,
    )
}
