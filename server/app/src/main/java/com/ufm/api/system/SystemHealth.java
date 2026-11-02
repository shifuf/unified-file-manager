package com.ufm.api.system;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * API 探针响应。使用显式 record 让 OpenAPI schema 稳定，不依赖 Map 的泛型推断。
 */
@Schema(name = "SystemHealth")
public record SystemHealth(
        String status,
        String role,
        String version,
        String time
) {
}
