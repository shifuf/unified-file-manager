plugins {
    `java-library`
}

description = "UFM 领域核心：数据库迁移 / 错误模型 / 通用 Web 基建 / 各领域 service"

dependencies {
    api(platform("org.springframework.boot:spring-boot-dependencies:${libs.versions.springBoot.get()}"))

    api(libs.spring.boot.starter.web)
    api(libs.spring.boot.starter.validation)
    api(libs.spring.boot.starter.security)
    api("io.swagger.core.v3:swagger-annotations-jakarta:2.2.22")

    api(libs.mybatis.plus.boot.starter)
    api(libs.flyway.core)
    api(libs.jjwt.api)
    runtimeOnly(libs.flyway.postgresql)
    implementation(libs.postgresql)
    runtimeOnly(libs.jjwt.impl)
    runtimeOnly(libs.jjwt.jackson)

    implementation(libs.jieba.analysis)
    implementation("org.apache.pdfbox:pdfbox:3.0.6")
    implementation(platform("software.amazon.awssdk:bom:${libs.versions.awsSdk.get()}"))
    implementation("software.amazon.awssdk:s3")
    implementation("software.amazon.awssdk:url-connection-client")
    implementation("software.amazon.awssdk:apache-client")

    testImplementation(libs.spring.boot.starter.test)
    testImplementation(libs.spring.security.test)
    testImplementation(libs.testcontainers.junit.jupiter)
    testImplementation(libs.testcontainers.postgresql)
    testImplementation("com.aliyun.oss:aliyun-sdk-oss:3.18.5")
    testRuntimeOnly(libs.flyway.postgresql)
    testRuntimeOnly(libs.postgresql)
}
