package com.ufm.common.error;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;

import java.util.Map;

/**
 * 统一错误体。对外 JSON 形如：
 * <pre>
 * { "error": { "code": "QUOTA_EXHAUSTED", "message": "...", "details": {...}, "requestId": "..." } }
 * </pre>
 *
 * <p>{@code details} 为自由结构（字段校验明细、冲突对象、重试建议等），为空时不输出，
 * 避免前端拿到无意义的 {@code null}。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"code", "message", "details", "requestId"})
public record ApiError(
        String code,
        String message,
        Map<String, Object> details,
        String requestId
) {

    public static ApiError of(ErrorCode code, String message, Map<String, Object> details, String requestId) {
        return new ApiError(code.name(), message, details, requestId);
    }

    public static ApiError of(ErrorCode code, String requestId) {
        return new ApiError(code.name(), code.defaultMessage(), null, requestId);
    }
}
