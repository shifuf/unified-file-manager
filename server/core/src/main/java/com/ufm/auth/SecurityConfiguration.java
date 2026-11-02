package com.ufm.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.auth.jwt.JwtClaims;
import com.ufm.auth.jwt.JwtService;
import com.ufm.common.error.*;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;
import java.net.URI;
import java.util.List;

@Configuration
public class SecurityConfiguration {
    @Bean
    org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer davMethods() {
        return web->{
            var firewall=new org.springframework.security.web.firewall.StrictHttpFirewall();
            firewall.setAllowedHttpMethods(List.of("GET","HEAD","OPTIONS","POST","PUT","PATCH","DELETE","PROPFIND","MKCOL","MOVE","COPY","LOCK","UNLOCK"));
            web.httpFirewall(firewall);
        };
    }
    @Bean
    SecurityFilterChain security(HttpSecurity http,JwtService jwt,RefreshTokenMapper sessions,ObjectMapper json,com.ufm.open.OpenApiAuthentication openApi,com.ufm.audit.AuditService audit,com.ufm.dav.DavService dav,com.ufm.common.config.GlobalSettings global) throws Exception {
        return http.csrf(csrf->csrf.disable())
                .sessionManagement(s->s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .formLogin(f->f.disable()).httpBasic(b->b.disable())
                .authorizeHttpRequests(a->a.requestMatchers("/api/auth/login","/api/auth/refresh",
                        "/api/auth/bootstrap","/api/auth/bootstrap/status","/api/system/health","/api/healthz",
                        "/actuator/health/**","/v3/api-docs/**","/swagger-ui/**","/swagger-ui.html",
                        "/api/public/**","/s/**","/fs/**","/lib/**","/d/**").permitAll()
                        .anyRequest().authenticated())
                .exceptionHandling(e->e.authenticationEntryPoint((r,s,x)->write(json,r,s,ErrorCode.UNAUTHORIZED))
                        .accessDeniedHandler((r,s,x)->write(json,r,s,ErrorCode.FORBIDDEN)))
                .addFilterBefore(new OncePerRequestFilter() {
                    @Override
                    protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)
                            throws ServletException,IOException {
                        if (!request.isSecure() && !List.of("/api/healthz","/actuator/health","/actuator/health/readiness","/actuator/health/liveness").contains(request.getRequestURI()) && global.get().forceHttps()) {
                            write(json,request,response,ErrorCode.FORBIDDEN); return;
                        }
                        String origin=request.getHeader("Origin");
                        if (!request.getMethod().equals("GET") && origin!=null && !sameOrigin(origin,request)) {
                            write(json,request,response,ErrorCode.FORBIDDEN); return;
                        }
                        if (request.getRequestURI().startsWith("/api/open/")) {
                            try (var wrapped=openApi.authenticate(request)) {
                                SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(wrapped.principal(),null,List.of()));
                                chain.doFilter(wrapped,response);
                            } catch (ApiException ex) { write(json,request,response,ex.getCode()); }
                            return;
                        }
                        String auth=request.getHeader("Authorization");
                        if (request.getRequestURI().startsWith("/dav/")) {
                            try {
                                var principal=dav.authenticate(request.getRequestURI(),auth,request.getRemoteAddr());
                                SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(principal,null,List.of()));
                                chain.doFilter(request,response);
                            } catch (ApiException ex) {
                                response.setHeader("WWW-Authenticate","Basic realm=\"UFM WebDAV\", charset=\"UTF-8\"");
                                write(json,request,response,ex.getCode());
                            }
                            return;
                        }
                        if (auth!=null && auth.startsWith("Bearer ")) {
                            try {
                                JwtClaims claims=jwt.verify(auth.substring(7));
                                if (!sessions.active(claims.sessionId(),claims.userId())) {
                                    write(json,request,response,ErrorCode.TOKEN_INVALID); return;
                                }
                                SecurityContextHolder.getContext().setAuthentication(
                                        new UsernamePasswordAuthenticationToken(claims,null,List.of()));
                            } catch (com.ufm.auth.jwt.JwtAuthenticationException ex) {
                                write(json,request,response,ErrorCode.TOKEN_INVALID); return;
                            }
                        }
                        chain.doFilter(request,response);
                    }
                },UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(new com.ufm.audit.AuditFilter(audit),UsernamePasswordAuthenticationFilter.class).build();
    }

    private static boolean sameOrigin(String value,HttpServletRequest request) {
        try {
            URI origin=URI.create(value);
            int port=origin.getPort()<0?("https".equals(origin.getScheme())?443:80):origin.getPort();
            return origin.getScheme().equals(request.getScheme()) && origin.getHost().equals(request.getServerName())
                    && port==request.getServerPort();
        } catch (RuntimeException ex) { return false; }
    }

    private static void write(ObjectMapper json,HttpServletRequest request,HttpServletResponse response,ErrorCode code)
            throws IOException {
        response.setStatus(code.status().value()); response.setContentType("application/json");
        json.writeValue(response.getOutputStream(),ApiErrorResponse.of(ApiError.of(code,
                String.valueOf(request.getAttribute(GlobalExceptionHandler.REQUEST_ID_ATTR)))));
    }
}
