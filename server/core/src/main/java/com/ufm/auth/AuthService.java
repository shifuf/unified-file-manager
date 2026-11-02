package com.ufm.auth;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.ufm.auth.jwt.JwtService;
import com.ufm.auth.totp.TotpService;
import com.ufm.common.config.UfmSecurityProperties;
import com.ufm.common.crypto.SecretCipher;
import com.ufm.common.error.ApiException;
import com.ufm.common.error.ErrorCode;
import com.ufm.common.id.UuidV7;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.*;

@Service
public class AuthService {
    private final UserMapper users;
    private final RefreshTokenMapper sessions;
    private final PasswordEncoder passwords;
    private final JwtService jwt;
    private final TotpService totp;
    private final SecretCipher cipher;
    private final UfmSecurityProperties config;
    private final Clock clock;
    private final LoginRateLimiter limiter;

    public AuthService(UserMapper users, RefreshTokenMapper sessions, PasswordEncoder passwords,
                       JwtService jwt, TotpService totp, SecretCipher cipher,
                       UfmSecurityProperties config, Clock clock,LoginRateLimiter limiter) {
        this.users=users; this.sessions=sessions; this.passwords=passwords; this.jwt=jwt;
        this.totp=totp; this.cipher=cipher; this.config=config; this.clock=clock;
        this.limiter=limiter;
    }

    public boolean initialized() { return users.bootstrapped() || users.selectCount(null)>0; }

    @Transactional
    public AuthDtos.Profile bootstrap(AuthDtos.Bootstrap input) {
        users.lockAdministrator();
        if (initialized()) throw new ApiException(ErrorCode.DUPLICATE_RESOURCE);
        validatePassword(input.password());
        UserEntity user=new UserEntity();
        user.setId(UUID.randomUUID()); user.setUsername(input.username());
        user.setPasswordHash(passwords.encode(input.password())); user.setDisplayName(input.displayName());
        user.setRole("SUPER_ADMIN"); user.setEnabled(true); user.setTotpEnabled(false);
        users.insert(user);
        users.markInitialized();
        return profile(user);
    }

    @Transactional
    public Issued login(AuthDtos.Login input, String ip, String ua) {
        limiter.check(input.username(),ip);
        UserEntity user=users.findForLogin(input.username());
        if (user==null || !passwords.matches(input.password(),user.getPasswordHash()))
            throw new ApiException(ErrorCode.INVALID_CREDENTIALS);
        if (!Boolean.TRUE.equals(user.getEnabled())) throw new ApiException(ErrorCode.ACCOUNT_DISABLED);
        verifyFactor(user,input.code());
        user.setLastLoginAt(now()); users.updateById(user);
        return issue(user,ip,ua);
    }

    @Transactional(noRollbackFor=ApiException.class)
    public Issued refresh(String raw) {
        if (raw==null || raw.length()>128) throw new ApiException(ErrorCode.TOKEN_INVALID);
        RefreshTokenEntity old=sessions.lockToken(hash(raw));
        if (old!=null && old.getRevokedAt()!=null && old.getReplacedBy()!=null) {
            sessions.revokeAll(old.getUserId());
            throw new ApiException(ErrorCode.TOKEN_INVALID);
        }
        if (old==null || old.getRevokedAt()!=null || old.getDeletedAt()!=null || !old.getExpiresAt().isAfter(now()))
            throw new ApiException(ErrorCode.TOKEN_INVALID);
        UserEntity user=requireUser(old.getUserId());
        Issued next=issue(user,old.getIp(),old.getUserAgent());
        old.setRevokedAt(now()); old.setLastUsedAt(now()); old.setReplacedBy(next.sessionId());
        sessions.updateById(old);
        return next;
    }

    public AuthDtos.Profile profile(UUID id) { return profile(requireUser(id)); }

    public List<AuthDtos.Session> list(UUID userId, UUID current) {
        return sessions.selectList(new QueryWrapper<RefreshTokenEntity>().eq("user_id",userId)
                .isNull("revoked_at").isNull("deleted_at").gt("expires_at",now()).orderByDesc("created_at"))
                .stream().map(s->new AuthDtos.Session(s.getId(),s.getCreatedAt(),s.getExpiresAt(),
                        s.getUserAgent(),s.getId().equals(current))).toList();
    }

    @Transactional
    public void revoke(UUID userId, UUID sessionId) {
        RefreshTokenEntity row=sessions.selectById(sessionId);
        if (row==null || !row.getUserId().equals(userId)) throw new ApiException(ErrorCode.NOT_FOUND);
        row.setRevokedAt(now()); sessions.updateById(row);
    }

    @Transactional
    public void password(UUID id, AuthDtos.Password input) {
        UserEntity user=verifyPassword(id,input.currentPassword()); verifyFactor(user,input.code());
        validatePassword(input.newPassword()); user.setPasswordHash(passwords.encode(input.newPassword()));
        user.setPasswordChangedAt(now()); users.updateById(user); sessions.revokeAll(id);
    }

    @Transactional
    public AuthDtos.Setup setup(UUID id, AuthDtos.Factor input) {
        UserEntity user=verifyPassword(id,input.password());
        if (Boolean.TRUE.equals(user.getTotpEnabled())) throw new ApiException(ErrorCode.CONFLICT);
        String secret=totp.generateSecret(); user.setTotpSecretEnc(cipher.encrypt(secret)); users.updateById(user);
        return new AuthDtos.Setup(secret,totp.otpauthUri(config.getIssuer(),user.getUsername(),secret));
    }

    @Transactional
    public void factor(UUID id, AuthDtos.Factor input, boolean enable) {
        UserEntity user=verifyPassword(id,input.password());
        if (user.getTotpSecretEnc()==null || !totp.verify(cipher.decrypt(user.getTotpSecretEnc()),input.code(),clock.instant()))
            throw new ApiException(ErrorCode.INVALID_CREDENTIALS);
        user.setTotpEnabled(enable);
        if (!enable) user.setTotpSecretEnc(null);
        users.updateById(user); sessions.revokeAll(id);
    }

    private UserEntity verifyPassword(UUID id,String password) {
        UserEntity user=requireUser(id);
        if (!passwords.matches(password,user.getPasswordHash())) throw new ApiException(ErrorCode.INVALID_CREDENTIALS);
        return user;
    }

    private void verifyFactor(UserEntity user,String code) {
        if (Boolean.TRUE.equals(user.getTotpEnabled())) {
            if (code==null) throw new ApiException(ErrorCode.TWO_FACTOR_REQUIRED);
            if (!totp.verify(cipher.decrypt(user.getTotpSecretEnc()),code,clock.instant()))
                throw new ApiException(ErrorCode.INVALID_CREDENTIALS);
        }
    }

    private UserEntity requireUser(UUID id) {
        UserEntity user=users.selectById(id);
        if (user==null || user.getDeletedAt()!=null || !Boolean.TRUE.equals(user.getEnabled()))
            throw new ApiException(ErrorCode.UNAUTHORIZED);
        return user;
    }

    private Issued issue(UserEntity user,String ip,String ua) {
        String raw=randomSecret();
        RefreshTokenEntity session=new RefreshTokenEntity(); session.setId(UUID.randomUUID());
        session.setUserId(user.getId()); session.setTokenHash(hash(raw));
        session.setExpiresAt(now().plus(config.getRefreshTtl())); session.setIp(ip);
        session.setUserAgent(ua==null?null:ua.substring(0,Math.min(512,ua.length())));
        sessions.insert(session);
        return new Issued(new AuthDtos.Tokens(jwt.issue(user.getId(),user.getUsername(),user.getRole(),session.getId()),
                jwt.accessTtl().toSeconds(),profile(user)),raw,session.getId());
    }

    public static String randomSecret() {
        byte[] bytes=new byte[32]; new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    public static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }

    private void validatePassword(String password) {
        if (!PasswordPolicy.violations(password).isEmpty()) throw new ApiException(ErrorCode.VALIDATION_FAILED);
    }

    private OffsetDateTime now() { return OffsetDateTime.ofInstant(clock.instant(),ZoneOffset.UTC); }
    private AuthDtos.Profile profile(UserEntity user) {
        return new AuthDtos.Profile(user.getId(),user.getUsername(),user.getDisplayName(),user.getRole(),
                Boolean.TRUE.equals(user.getTotpEnabled()));
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="AuthIssued")
    public record Issued(AuthDtos.Tokens body,String refresh,UUID sessionId) {}
}
