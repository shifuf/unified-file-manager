package com.ufm.generated.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.io.Serializable;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * <p>
 *
 * </p>
 *
 * @author UFM Generator
 * @since 2026-10-30
 */
@TableName("users")
public class UsersEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("username")
    private String username;

    @TableField("password_hash")
    private String passwordHash;

    @TableField("display_name")
    private String displayName;

    @TableField("role")
    private String role;

    @TableField("totp_secret_enc")
    private String totpSecretEnc;

    @TableField("totp_enabled")
    private Boolean totpEnabled;

    @TableField("enabled")
    private Boolean enabled;

    @TableField("last_login_at")
    private OffsetDateTime lastLoginAt;

    @TableField("created_at")
    private OffsetDateTime createdAt;

    @TableField("updated_at")
    private OffsetDateTime updatedAt;

    @TableField("deleted_at")
    private OffsetDateTime deletedAt;

    @TableField("password_changed_at")
    private OffsetDateTime passwordChangedAt;

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

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

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(OffsetDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }

    public OffsetDateTime getDeletedAt() {
        return deletedAt;
    }

    public void setDeletedAt(OffsetDateTime deletedAt) {
        this.deletedAt = deletedAt;
    }

    public OffsetDateTime getPasswordChangedAt() {
        return passwordChangedAt;
    }

    public void setPasswordChangedAt(OffsetDateTime passwordChangedAt) {
        this.passwordChangedAt = passwordChangedAt;
    }

    @Override
    public String toString() {
        return "UsersEntity{" +
            "id = " + id +
            ", username = " + username +
            ", passwordHash = " + passwordHash +
            ", displayName = " + displayName +
            ", role = " + role +
            ", totpSecretEnc = " + totpSecretEnc +
            ", totpEnabled = " + totpEnabled +
            ", enabled = " + enabled +
            ", lastLoginAt = " + lastLoginAt +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
            ", deletedAt = " + deletedAt +
            ", passwordChangedAt = " + passwordChangedAt +
        "}";
    }
}
