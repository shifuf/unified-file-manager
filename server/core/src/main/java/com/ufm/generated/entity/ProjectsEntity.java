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
@TableName("projects")
public class ProjectsEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("app_id")
    private String appId;

    @TableField("name")
    private String name;

    @TableField("description")
    private String description;

    @TableField("secret_hash")
    private String secretHash;

    @TableField("secret_enc")
    private String secretEnc;

    @TableField("quota_bytes")
    private Long quotaBytes;

    @TableField("quota_files")
    private Long quotaFiles;

    @TableField("used_bytes")
    private Long usedBytes;

    @TableField("used_files")
    private Long usedFiles;

    @TableField("notify_enabled")
    private Boolean notifyEnabled;

    @TableField("library_enabled")
    private Boolean libraryEnabled;

    @TableField("library_slug")
    private String librarySlug;

    @TableField("webdav_enabled")
    private Boolean webdavEnabled;

    @TableField("webdav_username")
    private String webdavUsername;

    @TableField("webdav_password_enc")
    private String webdavPasswordEnc;

    @TableField("allowed_domains")
    private String allowedDomains;

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

    public String getAppId() {
        return appId;
    }

    public void setAppId(String appId) {
        this.appId = appId;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getSecretHash() {
        return secretHash;
    }

    public void setSecretHash(String secretHash) {
        this.secretHash = secretHash;
    }

    public String getSecretEnc() {
        return secretEnc;
    }

    public void setSecretEnc(String secretEnc) {
        this.secretEnc = secretEnc;
    }

    public Long getQuotaBytes() {
        return quotaBytes;
    }

    public void setQuotaBytes(Long quotaBytes) {
        this.quotaBytes = quotaBytes;
    }

    public Long getQuotaFiles() {
        return quotaFiles;
    }

    public void setQuotaFiles(Long quotaFiles) {
        this.quotaFiles = quotaFiles;
    }

    public Long getUsedBytes() {
        return usedBytes;
    }

    public void setUsedBytes(Long usedBytes) {
        this.usedBytes = usedBytes;
    }

    public Long getUsedFiles() {
        return usedFiles;
    }

    public void setUsedFiles(Long usedFiles) {
        this.usedFiles = usedFiles;
    }

    public Boolean getNotifyEnabled() {
        return notifyEnabled;
    }

    public void setNotifyEnabled(Boolean notifyEnabled) {
        this.notifyEnabled = notifyEnabled;
    }

    public Boolean getLibraryEnabled() {
        return libraryEnabled;
    }

    public void setLibraryEnabled(Boolean libraryEnabled) {
        this.libraryEnabled = libraryEnabled;
    }

    public String getLibrarySlug() {
        return librarySlug;
    }

    public void setLibrarySlug(String librarySlug) {
        this.librarySlug = librarySlug;
    }

    public Boolean getWebdavEnabled() {
        return webdavEnabled;
    }

    public void setWebdavEnabled(Boolean webdavEnabled) {
        this.webdavEnabled = webdavEnabled;
    }

    public String getWebdavUsername() {
        return webdavUsername;
    }

    public void setWebdavUsername(String webdavUsername) {
        this.webdavUsername = webdavUsername;
    }

    public String getWebdavPasswordEnc() {
        return webdavPasswordEnc;
    }

    public void setWebdavPasswordEnc(String webdavPasswordEnc) {
        this.webdavPasswordEnc = webdavPasswordEnc;
    }

    public String getAllowedDomains() {
        return allowedDomains;
    }

    public void setAllowedDomains(String allowedDomains) {
        this.allowedDomains = allowedDomains;
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
        return "ProjectsEntity{" +
            "id = " + id +
            ", appId = " + appId +
            ", name = " + name +
            ", description = " + description +
            ", secretHash = " + secretHash +
            ", secretEnc = " + secretEnc +
            ", quotaBytes = " + quotaBytes +
            ", quotaFiles = " + quotaFiles +
            ", usedBytes = " + usedBytes +
            ", usedFiles = " + usedFiles +
            ", notifyEnabled = " + notifyEnabled +
            ", libraryEnabled = " + libraryEnabled +
            ", librarySlug = " + librarySlug +
            ", webdavEnabled = " + webdavEnabled +
            ", webdavUsername = " + webdavUsername +
            ", webdavPasswordEnc = " + webdavPasswordEnc +
            ", allowedDomains = " + allowedDomains +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
            ", deletedAt = " + deletedAt +
        "}";
    }
}
