package com.ufm.auth.jwt;

import java.time.Instant;
import java.util.UUID;

public record JwtClaims(
        UUID userId,
        String username,
        String role,
        UUID sessionId,
        Instant issuedAt,
        Instant expiresAt
) {
}
