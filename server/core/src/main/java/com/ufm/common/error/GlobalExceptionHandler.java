package com.ufm.common.error;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 全局异常 → 统一错误体。所有失败响应都带 requestId，便于日志串联。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /** 请求 ID 的 MDC 键，由 RequestIdFilter 写入。 */
    public static final String REQUEST_ID_ATTR = "ufm.requestId";

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiErrorResponse> handleApiException(ApiException ex, HttpServletRequest request) {
        // 4xx 属于预期分支，不打堆栈；5xx 才需要 stacktrace
        if (ex.getStatus().is5xxServerError()) {
            log.error("[{}] api exception: {} - {}", requestId(request), ex.getCode(), ex.getMessage(), ex);
        } else {
            log.debug("[{}] api exception: {} - {}", requestId(request), ex.getCode(), ex.getMessage());
        }
        ApiError error = ApiError.of(ex.getCode(), ex.getMessage(), ex.getDetails(), requestId(request));
        ResponseEntity.BodyBuilder response=ResponseEntity.status(ex.getStatus());
        if (ex.getCode()==ErrorCode.RATE_LIMITED) response.header("Retry-After","900");
        return response.body(ApiErrorResponse.of(error));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiErrorResponse> handleValidation(MethodArgumentNotValidException ex,
                                                             HttpServletRequest request) {
        Map<String, Object> fields = new LinkedHashMap<>();
        List<FieldError> errors = ex.getBindingResult().getFieldErrors();
        for (FieldError fe : errors) {
            fields.putIfAbsent(fe.getField(), fe.getDefaultMessage());
        }
        ApiError error = ApiError.of(
                ErrorCode.VALIDATION_FAILED,
                ErrorCode.VALIDATION_FAILED.defaultMessage(),
                Map.of("fields", fields),
                requestId(request));
        return ResponseEntity.badRequest().body(ApiErrorResponse.of(error));
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ResponseEntity<ApiErrorResponse> handleMissingParam(MissingServletRequestParameterException ex,
                                                               HttpServletRequest request) {
        ApiError error = ApiError.of(
                ErrorCode.VALIDATION_FAILED,
                "缺少必需参数：" + ex.getParameterName(),
                Map.of("parameter", ex.getParameterName()),
                requestId(request));
        return ResponseEntity.badRequest().body(ApiErrorResponse.of(error));
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ApiErrorResponse> handleTypeMismatch(MethodArgumentTypeMismatchException ex,
                                                               HttpServletRequest request) {
        ApiError error = ApiError.of(
                ErrorCode.INVALID_ARGUMENT,
                "参数类型不匹配：" + ex.getName(),
                Map.of("parameter", ex.getName()),
                requestId(request));
        return ResponseEntity.badRequest().body(ApiErrorResponse.of(error));
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<ApiErrorResponse> handleConstraintViolation(ConstraintViolationException ex,
                                                                      HttpServletRequest request) {
        Map<String, Object> fields = new LinkedHashMap<>();
        for (ConstraintViolation<?> violation : ex.getConstraintViolations()) {
            String path = violation.getPropertyPath().toString();
            int separator = path.lastIndexOf('.');
            String field = separator >= 0 ? path.substring(separator + 1) : path;
            fields.putIfAbsent(field, violation.getMessage());
        }
        ApiError error = ApiError.of(
                ErrorCode.VALIDATION_FAILED,
                ErrorCode.VALIDATION_FAILED.defaultMessage(),
                Map.of("fields", fields),
                requestId(request));
        return ResponseEntity.badRequest().body(ApiErrorResponse.of(error));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiErrorResponse> handleUnreadable(HttpMessageNotReadableException ex,
                                                             HttpServletRequest request) {
        ApiError error = ApiError.of(ErrorCode.MALFORMED_REQUEST, requestId(request));
        return ResponseEntity.badRequest().body(ApiErrorResponse.of(error));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ApiErrorResponse> handleMethodNotSupported(HttpRequestMethodNotSupportedException ex,
                                                                     HttpServletRequest request) {
        ApiError error = ApiError.of(ErrorCode.METHOD_NOT_ALLOWED, requestId(request));
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).body(ApiErrorResponse.of(error));
    }

    @ExceptionHandler(NoHandlerFoundException.class)
    public ResponseEntity<ApiErrorResponse> handleNoHandler(NoHandlerFoundException ex,
                                                            HttpServletRequest request) {
        ApiError error = ApiError.of(ErrorCode.NOT_FOUND, requestId(request));
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiErrorResponse.of(error));
    }

    /** 兜底：绝不把内部异常细节透给前端。 */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiErrorResponse> handleUnexpected(Exception ex, HttpServletRequest request) {
        String requestId = requestId(request);
        log.error("[{}] unhandled exception at {} {}", requestId, request.getMethod(), request.getRequestURI(), ex);
        ApiError error = ApiError.of(ErrorCode.INTERNAL_ERROR, ErrorCode.INTERNAL_ERROR.defaultMessage(),
                null, requestId);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(ApiErrorResponse.of(error));
    }

    private String requestId(HttpServletRequest request) {
        Object id = request.getAttribute(REQUEST_ID_ATTR);
        return id == null ? null : id.toString();
    }
}
