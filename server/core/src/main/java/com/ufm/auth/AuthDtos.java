package com.ufm.auth;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.UUID;

public final class AuthDtos {
    private AuthDtos() {}
    @io.swagger.v3.oas.annotations.media.Schema(name="AuthBootstrap")
    public record Bootstrap(@NotBlank @Pattern(regexp="[A-Za-z0-9_.-]{3,64}") String username,
                            @NotBlank String password, @Size(max=128) String displayName) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="AuthLogin")
    public record Login(@NotBlank @Size(max=64) String username,
                        @NotBlank @Size(max=72) String password, String code) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="AuthProfile")
    public record Profile(UUID id, String username, String displayName, String role, boolean totpEnabled) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="AuthTokens")
    public record Tokens(String accessToken, long expiresIn, Profile user) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="AuthPassword")
    public record Password(@NotBlank String currentPassword, @NotBlank String newPassword, String code) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="AuthFactor")
    public record Factor(@NotBlank String password, String code) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="AuthSetup")
    public record Setup(String secret, String otpauthUri) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="AuthSession")
    public record Session(UUID id, java.time.OffsetDateTime createdAt,
                          java.time.OffsetDateTime expiresAt, String userAgent, boolean current) {}
}
