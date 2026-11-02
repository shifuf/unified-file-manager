plugins {
    application
}

description = "MyBatis-Plus official code generator task"

dependencies {
    implementation(libs.mybatis.plus.generator)
    implementation(libs.mybatis.plus.core)
    implementation(libs.freemarker)
    runtimeOnly(libs.postgresql)
    runtimeOnly(libs.slf4j.simple)
}

application {
    mainClass = "com.ufm.codegen.MyBatisGenerator"
}

tasks.register<JavaExec>("generateMybatis") {
    group = "code generation"
    description = "Generate MyBatis-Plus entities and mappers from PostgreSQL"
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass = application.mainClass
    workingDir = rootProject.projectDir
}
