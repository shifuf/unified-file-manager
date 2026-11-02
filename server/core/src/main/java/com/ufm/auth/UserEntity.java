package com.ufm.auth;

import com.baomidou.mybatisplus.annotation.TableName;
import com.ufm.common.persistence.BaseUuidEntity;

import java.time.OffsetDateTime;

@TableName("users")
public class UserEntity extends BaseUuidEntity {

    private String username;
    private String passwordHash;
    private String displayName;
    private String role;
    private String totpSecretEnc;
    private Boolean totpEnabled;
    private Boolean enabled;
    private OffsetDateTime lastLoginAt;
    private OffsetDateTime passwordChangedAt;

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getPasswordHash() {
        return passwordHash;
    }

    public void setPasswordHash(String passwordHash) {
        this.passwordHash = passwordHash;
    }

    public String getDisplayName() {
        return displayName;
    }

    public void setDisplayName(String displayName) {
        this.displayName = displayName;
    }

    public String getRole() {
        return role;
    }

    public void setRole(String role) {
        this.role = role;
    }

    public String getTotpSecretEnc() {
        return totpSecretEnc;
    }

    public void setTotpSecretEnc(String totpSecretEnc) {
        this.totpSecretEnc = totpSecretEnc;
    }

    public Boolean getTotpEnabled() {
        return totpEnabled;
    }

    public void setTotpEnabled(Boolean totpEnabled) {
        this.totpEnabled = totpEnabled;
    }

    public Boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(Boolean enabled) {
        this.enabled = enabled;
    }

    public OffsetDateTime getLastLoginAt() {
        return lastLoginAt;
    }

    public void setLastLoginAt(OffsetDateTime lastLoginAt) {
        this.lastLoginAt = lastLoginAt;
    }

    public OffsetDateTime getPasswordChangedAt() {
        return passwordChangedAt;
    }

    public void setPasswordChangedAt(OffsetDateTime passwordChangedAt) {
        this.passwordChangedAt = passwordChangedAt;
    }
}
