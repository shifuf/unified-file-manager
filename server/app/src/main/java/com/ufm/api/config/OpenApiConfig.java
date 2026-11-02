package com.ufm.api.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * OpenAPI 契约入口。统一错误响应由 controller 的 @ApiResponse 引用，
 * 避免手工拼装 schema 与 springdoc 的生成结果冲突。
 */
@Configuration
public class OpenApiConfig {

    private final String version;

    public OpenApiConfig(@Value("${ufm.version:0.2.0}") String version) {
        this.version = version;
    }

    @Bean
    public OpenAPI ufmOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("Unified File Manager API")
                        .version(version)
                        .description("统一文件管理 v2 API。失败响应统一为 { error: { code, message, details, requestId } }。"));
    }
}
