package com.ufm.auth.jwt;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;

import javax.crypto.SecretKey;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import java.util.UUID;

public final class JwtService {

    private final SecretKey key;
    private final Duration accessTtl;
    private final String issuer;
    private final Clock clock;

    public JwtService(String base64Secret, Duration accessTtl, String issuer, Clock clock) {
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(base64Secret);
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("UFM_JWT_SECRET must be base64 encoded", ex);
        }
        if (decoded.length < 32) {
            throw new IllegalArgumentException("UFM_JWT_SECRET must decode to at least 32 bytes");
        }
        if (accessTtl.isZero() || accessTtl.isNegative()) {
            throw new IllegalArgumentException("Access token TTL must be positive");
        }
        this.key = Keys.hmacShaKeyFor(decoded);
        this.accessTtl = accessTtl;
        this.issuer = issuer;
        this.clock = clock;
    }

    public String issue(UUID userId, String username, String role, UUID sessionId) {
        Instant now = clock.instant();
        return Jwts.builder()
                .issuer(issuer)
                .subject(userId.toString())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(accessTtl)))
                .claim("username", username)
                .claim("role", role)
                .claim("sid", sessionId.toString())
                .signWith(key)
                .compact();
    }

    public JwtClaims verify(String token) {
        try {
            Claims claims = Jwts.parser()
                    .verifyWith(key)
                    .requireIssuer(issuer)
                    .clock(() -> Date.from(clock.instant()))
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
            return new JwtClaims(
                    UUID.fromString(claims.getSubject()),
                    claims.get("username", String.class),
                    claims.get("role", String.class),
                    UUID.fromString(claims.get("sid", String.class)),
                    claims.getIssuedAt().toInstant(),
                    claims.getExpiration().toInstant()
            );
        } catch (ExpiredJwtException ex) {
            throw new JwtAuthenticationException(
                    JwtAuthenticationException.Reason.EXPIRED, "Access token expired", ex);
        } catch (JwtException | IllegalArgumentException ex) {
            throw new JwtAuthenticationException(
                    JwtAuthenticationException.Reason.INVALID, "Access token invalid", ex);
        }
    }

    public Duration accessTtl() {
        return accessTtl;
    }
}
