package com.ufm.auth;

import com.ufm.auth.jwt.JwtClaims;
import com.ufm.common.config.UfmSecurityProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService service;
    private final UfmSecurityProperties config;
    public AuthController(AuthService service,UfmSecurityProperties config) { this.service=service; this.config=config; }

    @GetMapping("/bootstrap/status")
    public Map<String,Boolean> status() { return Map.of("initialized",service.initialized()); }

    @PostMapping("/bootstrap")
    public ResponseEntity<AuthDtos.Profile> bootstrap(@Valid @RequestBody AuthDtos.Bootstrap input) {
        return ResponseEntity.status(201).body(service.bootstrap(input));
    }

    @PostMapping("/login")
    public ResponseEntity<AuthDtos.Tokens> login(@Valid @RequestBody AuthDtos.Login input,HttpServletRequest request) {
        return tokens(service.login(input,request.getRemoteAddr(),request.getHeader("User-Agent")));
    }

    @PostMapping("/refresh")
    public ResponseEntity<AuthDtos.Tokens> refresh(@CookieValue(name="ufm_refresh",required=false) String refresh) {
        return tokens(service.refresh(refresh));
    }

    @GetMapping("/profile")
    public AuthDtos.Profile profile(@AuthenticationPrincipal JwtClaims principal) { return service.profile(principal.userId()); }

    @PostMapping("/logout")
    public ResponseEntity<Void> logout(@AuthenticationPrincipal JwtClaims principal) {
        service.revoke(principal.userId(),principal.sessionId());
        return ResponseEntity.noContent().header(HttpHeaders.SET_COOKIE,cookie("",0)).build();
    }

    @GetMapping("/sessions")
    public Map<String,Object> sessions(@AuthenticationPrincipal JwtClaims principal) {
        return Map.of("items",service.list(principal.userId(),principal.sessionId()));
    }

    @DeleteMapping("/sessions/{id}")
    @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
    public void revoke(@AuthenticationPrincipal JwtClaims principal,@PathVariable UUID id) {
        service.revoke(principal.userId(),id);
    }

    @PostMapping("/password")
    @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
    public void password(@AuthenticationPrincipal JwtClaims principal,@Valid @RequestBody AuthDtos.Password input) {
        service.password(principal.userId(),input);
    }

    @GetMapping("/2fa/status")
    public Map<String,Boolean> factorStatus(@AuthenticationPrincipal JwtClaims principal) {
        return Map.of("enabled",service.profile(principal.userId()).totpEnabled());
    }

    @PostMapping("/2fa/setup")
    public AuthDtos.Setup setup(@AuthenticationPrincipal JwtClaims principal,@Valid @RequestBody AuthDtos.Factor input) {
        return service.setup(principal.userId(),input);
    }

    @PostMapping("/2fa/{action:enable|disable}")
    @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
    public void factor(@AuthenticationPrincipal JwtClaims principal,@PathVariable String action,
                       @Valid @RequestBody AuthDtos.Factor input) {
        service.factor(principal.userId(),input,action.equals("enable"));
    }

    private ResponseEntity<AuthDtos.Tokens> tokens(AuthService.Issued issued) {
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE,cookie(issued.refresh(),config.getRefreshTtl().toSeconds()))
                .header(HttpHeaders.CACHE_CONTROL,"no-store").body(issued.body());
    }

    private String cookie(String value,long age) {
        return ResponseCookie.from("ufm_refresh",value).httpOnly(true).secure(config.isCookieSecure())
                .sameSite(config.getCookieSameSite()).path("/api/auth").maxAge(age).build().toString();
    }
}
