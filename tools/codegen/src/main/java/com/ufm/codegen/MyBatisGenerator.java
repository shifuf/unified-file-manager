package com.ufm.codegen;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.generator.FastAutoGenerator;
import com.baomidou.mybatisplus.generator.config.TemplateType;
import com.baomidou.mybatisplus.generator.config.converts.PostgreSqlTypeConvert;
import com.baomidou.mybatisplus.generator.config.rules.DateType;
import com.baomidou.mybatisplus.generator.config.rules.IColumnType;
import com.baomidou.mybatisplus.generator.engine.FreemarkerTemplateEngine;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;

/**
 * Generates only the persistence layer. Domain services, controllers and security
 * remain hand-written because they encode business rules the generator cannot infer.
 */
public final class MyBatisGenerator {

    private static final List<String> TABLES = List.of(
            "users", "refresh_tokens", "projects", "storage_configs", "project_storage",
            "files", "file_versions", "file_derivatives", "folders",
            "folder_public_policies", "share_links", "folder_share_links",
            "upload_credentials", "project_secrets", "tasks", "download_records",
            "download_daily_stats", "access_daily_stats", "share_ip_stats", "ip_bans",
            "audit_logs", "notify_channels", "notify_deliveries", "notifications",
            "settings", "backups", "nonces"
    );

    private MyBatisGenerator() {
    }

    public static void main(String[] args) {
        String url = requiredEnv("UFM_DB_URL");
        String username = requiredEnv("UFM_DB_USER");
        String password = requiredEnv("UFM_DB_PASSWORD");
        String outputDir = Path.of("server", "core", "src", "main", "java").toAbsolutePath().toString();

        FastAutoGenerator.create(url, username, password)
                .dataSourceConfig(builder -> builder.typeConvert(new PostgreSqlTypeConvert() {
                    @Override
                    public com.baomidou.mybatisplus.generator.config.rules.IColumnType processTypeConvert(
                            com.baomidou.mybatisplus.generator.config.GlobalConfig globalConfig,
                            String fieldType) {
                        return switch (fieldType.toLowerCase()) {
                            case "uuid" -> new ColumnTypeSpec("UUID", "java.util.UUID");
                            case "timestamptz" -> new ColumnTypeSpec("OffsetDateTime", "java.time.OffsetDateTime");
                            case "jsonb", "inet" -> new ColumnTypeSpec("String", "java.lang.String");
                            default -> super.processTypeConvert(globalConfig, fieldType);
                        };
                    }
                }).typeConvertHandler((globalConfig, typeRegistry, metaInfo) -> {
                    final String typeName = metaInfo.getTypeName().toLowerCase();
                    return switch (typeName) {
                        case "uuid" -> new ColumnTypeSpec("UUID", "java.util.UUID");
                        case "timestamptz" -> new ColumnTypeSpec("OffsetDateTime", "java.time.OffsetDateTime");
                        case "jsonb", "inet" -> new ColumnTypeSpec("String", "java.lang.String");
                        default -> typeRegistry.getColumnType(metaInfo);
                    };
                }))
                .globalConfig(builder -> builder
                        .author("UFM Generator")
                        .outputDir(outputDir)
                        .dateType(DateType.TIME_PACK)
                        .disableOpenDir()
                        .commentDate("yyyy-MM-dd"))
                .packageConfig(builder -> builder
                        .parent("com.ufm.generated")
                        .entity("entity")
                        .mapper("mapper"))
                .strategyConfig(builder -> builder
                        .addInclude(TABLES)
                        .entityBuilder()
                        .formatFileName("%sEntity")
                        .idType(IdType.INPUT)
                        .enableTableFieldAnnotation()
                        .enableFileOverride()
                        .mapperBuilder()
                        .formatMapperFileName("%sMapper")
                        .enableBaseResultMap()
                        .enableBaseColumnList()
                        .enableFileOverride())
                .templateConfig(builder -> builder.disable(
                        TemplateType.SERVICE,
                        TemplateType.SERVICE_IMPL,
                        TemplateType.CONTROLLER,
                        TemplateType.XML))
                .templateEngine(new FreemarkerTemplateEngine())
                .execute();

        deleteGeneratedDirectory(outputDir, "controller");
        deleteGeneratedDirectory(outputDir, "service");
        deleteGeneratedDirectory(outputDir, "mapper", "xml");
    }

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }

    private static void deleteGeneratedDirectory(String outputDir, String... segments) {
        Path target = Path.of(outputDir, "com", "ufm", "generated");
        for (String segment : segments) {
            target = target.resolve(segment);
        }
        if (!Files.exists(target)) {
            return;
        }
        try (var paths = Files.walk(target)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.delete(path);
                } catch (IOException ex) {
                    throw new IllegalStateException("Unable to remove generated path " + path, ex);
                }
            });
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to clean generated directory " + target, ex);
        }
    }

    private record ColumnTypeSpec(String type, String pkg) implements IColumnType {
        @Override
        public String getType() {
            return type;
        }

        @Override
        public String getPkg() {
            return pkg;
        }
    }
}
