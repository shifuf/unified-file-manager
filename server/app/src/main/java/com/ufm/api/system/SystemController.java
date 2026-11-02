package com.ufm.api.system;

import com.ufm.common.error.ApiErrorResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;

/**
 * 系统探针。阶段 1 只做骨架连通性验证（CI 冒烟 + 前端联调占位），
 * 完整实现（版本检查、健康明细）在阶段 7 补齐。
 */
@RestController
@RequestMapping("/api/system")
@Tag(name = "System", description = "系统探针与版本信息")
public class SystemController {

    private final String version;

    public SystemController(@Value("${ufm.version:0.0.0}") String version) {
        this.version = version;
    }

    @GetMapping(value = "/health", produces = MediaType.APPLICATION_JSON_VALUE)
    @Operation(summary = "API 健康状态", description = "阶段 1 骨架连通性探针")
    @ApiResponse(responseCode = "200", description = "服务正常")
    @ApiResponse(
            responseCode = "500",
            description = "服务器内部错误",
            content = @Content(schema = @Schema(implementation = ApiErrorResponse.class)))
    public SystemHealth health() {
        return new SystemHealth("UP", "api", version, Instant.now().toString());
    }
}
