package com.ufm.common.web;

import com.ufm.common.persistence.MaintenanceGate;
import com.ufm.common.error.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.stereotype.Component;
import org.springframework.core.annotation.Order;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;

@Component
@Order(org.springframework.core.Ordered.HIGHEST_PRECEDENCE+20)
public class MaintenanceFilter extends OncePerRequestFilter {
    private final MaintenanceGate gate;
    private final ObjectMapper json;
    public MaintenanceFilter(MaintenanceGate gate,ObjectMapper json) { this.gate=gate; this.json=json; }
    @Override protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getRequestURI().equals("/api/healthz") || request.getRequestURI().startsWith("/actuator/health");
    }
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
        MaintenanceGate.Lease lease;
        try { lease=gate.shared(); }
        catch (ApiException ex) {
            response.setStatus(503); response.setContentType("application/json"); response.setHeader("Retry-After","30");
            json.writeValue(response.getOutputStream(),ApiErrorResponse.of(ApiError.of(ErrorCode.SERVICE_UNAVAILABLE,"maintenance"))); return;
        }
        try (lease) { chain.doFilter(request,response); }
    }
}
