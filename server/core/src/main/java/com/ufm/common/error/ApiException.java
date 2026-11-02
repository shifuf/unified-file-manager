package com.ufm.common.error;

import org.springframework.http.HttpStatus;

import java.util.Map;

/**
 * 业务异常基类。service 层抛出，由 {@link GlobalExceptionHandler} 统一转成 {@link ApiErrorResponse}。
 *
 * <p>约定：
 * <ul>
 *   <li>message 面向终端用户，避免暴露内部实现细节；</li>
 *   <li>details 只放可安全外发的结构化上下文（字段名、数量、上限值等）；</li>
 *   <li>不要把 SQL、堆栈、内网地址写进 message/details。</li>
 * </ul>
 */
public class ApiException extends RuntimeException {

    private final ErrorCode code;
    private final transient Map<String, Object> details;
    private final HttpStatus overrideStatus;

    public ApiException(ErrorCode code) {
        this(code, code.defaultMessage(), null, null);
    }

    public ApiException(ErrorCode code, String message) {
        this(code, message, null, null);
    }

    public ApiException(ErrorCode code, String message, Map<String, Object> details) {
        this(code, message, details, null);
    }

    public ApiException(ErrorCode code, String message, Map<String, Object> details, HttpStatus overrideStatus) {
        super(message);
        this.code = code;
        this.details = details;
        this.overrideStatus = overrideStatus;
    }

    public ErrorCode getCode() {
        return code;
    }

    public Map<String, Object> getDetails() {
        return details;
    }

    public HttpStatus getStatus() {
        return overrideStatus != null ? overrideStatus : code.status();
    }

    // ---------- 便捷构造 ----------

    public static ApiException notFound(ErrorCode code, String message) {
        return new ApiException(code, message);
    }

    public static ApiException validation(String message, Map<String, Object> details) {
        return new ApiException(ErrorCode.VALIDATION_FAILED, message, details);
    }

    public static ApiException conflict(ErrorCode code, String message) {
        return new ApiException(code, message);
    }

    public static ApiException forbidden(String message) {
        return new ApiException(ErrorCode.FORBIDDEN, message);
    }
}
