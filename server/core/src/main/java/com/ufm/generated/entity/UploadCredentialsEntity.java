package com.ufm.generated.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.io.Serializable;
import java.lang.String;
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
@TableName("upload_credentials")
public class UploadCredentialsEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("project_id")
    private UUID projectId;

    @TableField("token_hash")
    private String tokenHash;

    @TableField("scope")
    private String scope;

    @TableField("max_bytes")
    private Long maxBytes;

    @TableField("used_bytes")
    private Long usedBytes;

    @TableField("max_files")
    private Long maxFiles;

    @TableField("used_files")
    private Long usedFiles;

    @TableField("expires_at")
    private OffsetDateTime expiresAt;

    @TableField("revoked_at")
    private OffsetDateTime revokedAt;

    @TableField("created_by")
    private UUID createdBy;

    @TableField("created_at")
    private OffsetDateTime createdAt;

    @TableField("updated_at")
    private OffsetDateTime updatedAt;

    @TableField("deleted_at")
    private OffsetDateTime deletedAt;

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public UUID getProjectId() {
        return projectId;
    }

    public void setProjectId(UUID projectId) {
        this.projectId = projectId;
    }

    public String getTokenHash() {
        return tokenHash;
    }

    public void setTokenHash(String tokenHash) {
        this.tokenHash = tokenHash;
    }

    public String getScope() {
        return scope;
    }

    public void setScope(String scope) {
        this.scope = scope;
    }

    public Long getMaxBytes() {
        return maxBytes;
    }

    public void setMaxBytes(Long maxBytes) {
        this.maxBytes = maxBytes;
    }

    public Long getUsedBytes() {
        return usedBytes;
    }

    public void setUsedBytes(Long usedBytes) {
        this.usedBytes = usedBytes;
    }

    public Long getMaxFiles() {
        return maxFiles;
    }

    public void setMaxFiles(Long maxFiles) {
        this.maxFiles = maxFiles;
    }

    public Long getUsedFiles() {
        return usedFiles;
    }

    public void setUsedFiles(Long usedFiles) {
        this.usedFiles = usedFiles;
    }

    public OffsetDateTime getExpiresAt() {
        return expiresAt;
    }

    public void setExpiresAt(OffsetDateTime expiresAt) {
        this.expiresAt = expiresAt;
    }

    public OffsetDateTime getRevokedAt() {
        return revokedAt;
    }

    public void setRevokedAt(OffsetDateTime revokedAt) {
        this.revokedAt = revokedAt;
    }

    public UUID getCreatedBy() {
        return createdBy;
    }

    public void setCreatedBy(UUID createdBy) {
        this.createdBy = createdBy;
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

    @Override
    public String toString() {
        return "UploadCredentialsEntity{" +
            "id = " + id +
            ", projectId = " + projectId +
            ", tokenHash = " + tokenHash +
            ", scope = " + scope +
            ", maxBytes = " + maxBytes +
            ", usedBytes = " + usedBytes +
            ", maxFiles = " + maxFiles +
            ", usedFiles = " + usedFiles +
            ", expiresAt = " + expiresAt +
            ", revokedAt = " + revokedAt +
            ", createdBy = " + createdBy +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
            ", deletedAt = " + deletedAt +
        "}";
    }
}
