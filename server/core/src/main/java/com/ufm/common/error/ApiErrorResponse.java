package com.ufm.common.error;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;

/**
 * 错误响应外壳，保证所有失败响应的顶层结构一致：{@code {"error": {...}}}。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"error"})
public record ApiErrorResponse(ApiError error) {

    public static ApiErrorResponse of(ApiError error) {
        return new ApiErrorResponse(error);
    }
}
