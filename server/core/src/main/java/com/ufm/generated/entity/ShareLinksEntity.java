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
@TableName("share_links")
public class ShareLinksEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("file_id")
    private UUID fileId;

    @TableField("token")
    private String token;

    @TableField("custom_path")
    private String customPath;

    @TableField("password_hash")
    private String passwordHash;

    @TableField("expires_at")
    private OffsetDateTime expiresAt;

    @TableField("max_downloads")
    private Long maxDownloads;

    @TableField("download_count")
    private Long downloadCount;

    @TableField("preview_only")
    private Boolean previewOnly;

    @TableField("allowed_ips")
    private String allowedIps;

    @TableField("watermark")
    private String watermark;

    @TableField("enabled")
    private Boolean enabled;

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

    public UUID getFileId() {
        return fileId;
    }

    public void setFileId(UUID fileId) {
        this.fileId = fileId;
    }

    public String getToken() {
        return token;
    }

    public void setToken(String token) {
        this.token = token;
    }

    public String getCustomPath() {
        return customPath;
    }

    public void setCustomPath(String customPath) {
        this.customPath = customPath;
    }

    public String getPasswordHash() {
        return passwordHash;
    }

    public void setPasswordHash(String passwordHash) {
        this.passwordHash = passwordHash;
    }

    public OffsetDateTime getExpiresAt() {
        return expiresAt;
    }

    public void setExpiresAt(OffsetDateTime expiresAt) {
        this.expiresAt = expiresAt;
    }

    public Long getMaxDownloads() {
        return maxDownloads;
    }

    public void setMaxDownloads(Long maxDownloads) {
        this.maxDownloads = maxDownloads;
    }

    public Long getDownloadCount() {
        return downloadCount;
    }

    public void setDownloadCount(Long downloadCount) {
        this.downloadCount = downloadCount;
    }

    public Boolean getPreviewOnly() {
        return previewOnly;
    }

    public void setPreviewOnly(Boolean previewOnly) {
        this.previewOnly = previewOnly;
    }

    public String getAllowedIps() {
        return allowedIps;
    }

    public void setAllowedIps(String allowedIps) {
        this.allowedIps = allowedIps;
    }

    public String getWatermark() {
        return watermark;
    }

    public void setWatermark(String watermark) {
        this.watermark = watermark;
    }

    public Boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(Boolean enabled) {
        this.enabled = enabled;
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
        return "ShareLinksEntity{" +
            "id = " + id +
            ", fileId = " + fileId +
            ", token = " + token +
            ", customPath = " + customPath +
            ", passwordHash = " + passwordHash +
            ", expiresAt = " + expiresAt +
            ", maxDownloads = " + maxDownloads +
            ", downloadCount = " + downloadCount +
            ", previewOnly = " + previewOnly +
            ", allowedIps = " + allowedIps +
            ", watermark = " + watermark +
            ", enabled = " + enabled +
            ", createdBy = " + createdBy +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
            ", deletedAt = " + deletedAt +
        "}";
    }
}
