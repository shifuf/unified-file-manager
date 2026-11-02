package com.ufm.common.error;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.slf4j.MDC;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * 为每个请求生成或透传 X-Request-Id，写入请求属性与响应头，并放行 CORS 暴露头。
 *
 * <p>上游（Nginx）若已注入 X-Request-Id 则复用，保证跨层日志可串联；
 * 否则生成 24 位十六进制短 ID。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class RequestIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Request-Id";
    private static final Pattern SAFE_ID = Pattern.compile("^[A-Za-z0-9._-]{8,64}$");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String incoming = request.getHeader(HEADER);
        String requestId = (incoming != null && SAFE_ID.matcher(incoming).matches())
                ? incoming
                : UUID.randomUUID().toString().replace("-", "").substring(0, 24);

        request.setAttribute(GlobalExceptionHandler.REQUEST_ID_ATTR, requestId);
        response.setHeader(HEADER, requestId);
        String previousRequestId = MDC.get("requestId");
        MDC.put("requestId", requestId);
        try {
            chain.doFilter(request, response);
        } finally {
            if (previousRequestId == null) {
                MDC.remove("requestId");
            } else {
                MDC.put("requestId", previousRequestId);
            }
        }
    }
}
