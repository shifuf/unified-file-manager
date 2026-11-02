package com.ufm.common.error;

import org.springframework.http.HttpStatus;

/**
 * 全局错误码字典。
 *
 * <p>契约：错误码一经发布不得改名（前端按 code 做分支处理），只允许新增。
 * 命名规范：SCREAMING_SNAKE_CASE，语义化、可判读、与 HTTP 状态解耦。
 *
 * <p>HTTP 状态由 {@link #status()} 给出默认值，个别场景可通过
 * {@link ApiException#getStatus()} 覆盖（极少数，需在注释里写明原因）。
 */
public enum ErrorCode {

    // ---------- 400 参数 / 请求 ----------
    VALIDATION_FAILED(HttpStatus.BAD_REQUEST, "请求参数校验失败"),
    INVALID_ARGUMENT(HttpStatus.BAD_REQUEST, "参数不合法"),
    MALFORMED_REQUEST(HttpStatus.BAD_REQUEST, "请求体格式错误"),
    UNSUPPORTED_MEDIA_TYPE(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "不支持的请求内容类型"),
    METHOD_NOT_ALLOWED(HttpStatus.METHOD_NOT_ALLOWED, "请求方法不被支持"),

    // ---------- 401 / 403 ----------
    UNAUTHORIZED(HttpStatus.UNAUTHORIZED, "未登录或登录态已失效"),
    INVALID_CREDENTIALS(HttpStatus.UNAUTHORIZED, "用户名、密码或验证码错误"),
    TOKEN_EXPIRED(HttpStatus.UNAUTHORIZED, "凭证已过期"),
    TOKEN_INVALID(HttpStatus.UNAUTHORIZED, "凭证无效"),
    TWO_FACTOR_REQUIRED(HttpStatus.UNAUTHORIZED, "需要二次验证"),
    FORBIDDEN(HttpStatus.FORBIDDEN, "无权访问该资源"),
    ACCOUNT_DISABLED(HttpStatus.FORBIDDEN, "账号已被停用"),
    SHARE_PASSWORD_REQUIRED(HttpStatus.FORBIDDEN, "需要分享密码"),
    SHARE_EXPIRED(HttpStatus.FORBIDDEN, "分享已过期"),

    // ---------- 404 ----------
    NOT_FOUND(HttpStatus.NOT_FOUND, "资源不存在"),
    PROJECT_NOT_FOUND(HttpStatus.NOT_FOUND, "项目不存在"),
    FILE_NOT_FOUND(HttpStatus.NOT_FOUND, "文件不存在"),
    STORAGE_NOT_FOUND(HttpStatus.NOT_FOUND, "存储配置不存在"),

    // ---------- 409 冲突 ----------
    CONFLICT(HttpStatus.CONFLICT, "资源状态冲突"),
    DUPLICATE_RESOURCE(HttpStatus.CONFLICT, "资源已存在"),
    VERSION_CONFLICT(HttpStatus.CONFLICT, "数据已被修改，请刷新后重试"),

    // ---------- 413 / 415 / 429 ----------
    PAYLOAD_TOO_LARGE(HttpStatus.PAYLOAD_TOO_LARGE, "请求体过大"),
    QUOTA_EXHAUSTED(HttpStatus.INSUFFICIENT_STORAGE, "存储配额已用尽"),
    STORAGE_PATH_INVALID(HttpStatus.BAD_REQUEST, "存储路径不存在或不可写"),
    RATE_LIMITED(HttpStatus.TOO_MANY_REQUESTS, "请求过于频繁，请稍后重试"),

    // ---------- 5xx ----------
    INTERNAL_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, "服务器内部错误"),
    SERVICE_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "服务暂不可用"),
    STORAGE_UNAVAILABLE(HttpStatus.BAD_GATEWAY, "存储服务不可用"),
    UPSTREAM_TIMEOUT(HttpStatus.GATEWAY_TIMEOUT, "上游服务超时");

    private final HttpStatus status;
    private final String defaultMessage;

    ErrorCode(HttpStatus status, String defaultMessage) {
        this.status = status;
        this.defaultMessage = defaultMessage;
    }

    public HttpStatus status() {
        return status;
    }

    public String defaultMessage() {
        return defaultMessage;
    }
}
