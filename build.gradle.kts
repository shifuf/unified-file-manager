plugins {
    alias(libs.plugins.spring.boot) apply false
}

allprojects {
    group = "com.ufm"
    version = providers.gradleProperty("ufm.version").get()
}

subprojects {
    apply(plugin = "java")

    // 目标运行时：Java 21 LTS（规格书 §1）。toolchain 缺失时由 foojay 自动拉取，
    // CI 用 actions/setup-java 预装，本地装到 ~/.jdks 即可被自动发现。
    configure<JavaPluginExtension> {
        toolchain {
            languageVersion = JavaLanguageVersion.of(21)
        }
    }

    tasks.withType<JavaCompile>().configureEach {
        options.encoding = "UTF-8"
        options.compilerArgs.add("-parameters")
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        systemProperty("file.encoding", "UTF-8")
    }
}
