package com.ufm.audit;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;

public class AuditFilter extends OncePerRequestFilter {
    private final AuditService audit;
    public AuditFilter(AuditService audit) { this.audit=audit; }
    @Override protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/api/") || java.util.Set.of("GET","HEAD","OPTIONS").contains(request.getMethod());
    }
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws IOException,ServletException {
        try { chain.doFilter(request,response); }
        finally {
            try { audit.append(request,response); }
            catch (RuntimeException ex) { org.slf4j.LoggerFactory.getLogger(AuditFilter.class).error("Unable to persist request audit; request id {}",request.getAttribute(com.ufm.common.error.GlobalExceptionHandler.REQUEST_ID_ATTR)); }
        }
    }
}
