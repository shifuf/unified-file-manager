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
@TableName("share_ip_stats")
public class ShareIpStatsEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("ip")
    private String ip;

    @TableField("download_count")
    private Long downloadCount;

    @TableField("rate_limit_count")
    private Long rateLimitCount;

    @TableField("last_file_id")
    private UUID lastFileId;

    @TableField("last_access_at")
    private OffsetDateTime lastAccessAt;

    @TableField("ban_until")
    private OffsetDateTime banUntil;

    @TableField("permanent_ban")
    private Boolean permanentBan;

    @TableField("created_at")
    private OffsetDateTime createdAt;

    @TableField("updated_at")
    private OffsetDateTime updatedAt;

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public String getIp() {
        return ip;
    }

    public void setIp(String ip) {
        this.ip = ip;
    }

    public Long getDownloadCount() {
        return downloadCount;
    }

    public void setDownloadCount(Long downloadCount) {
        this.downloadCount = downloadCount;
    }

    public Long getRateLimitCount() {
        return rateLimitCount;
    }

    public void setRateLimitCount(Long rateLimitCount) {
        this.rateLimitCount = rateLimitCount;
    }

    public UUID getLastFileId() {
        return lastFileId;
    }

    public void setLastFileId(UUID lastFileId) {
        this.lastFileId = lastFileId;
    }

    public OffsetDateTime getLastAccessAt() {
        return lastAccessAt;
    }

    public void setLastAccessAt(OffsetDateTime lastAccessAt) {
        this.lastAccessAt = lastAccessAt;
    }

    public OffsetDateTime getBanUntil() {
        return banUntil;
    }

    public void setBanUntil(OffsetDateTime banUntil) {
        this.banUntil = banUntil;
    }

    public Boolean getPermanentBan() {
        return permanentBan;
    }

    public void setPermanentBan(Boolean permanentBan) {
        this.permanentBan = permanentBan;
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

    @Override
    public String toString() {
        return "ShareIpStatsEntity{" +
            "id = " + id +
            ", ip = " + ip +
            ", downloadCount = " + downloadCount +
            ", rateLimitCount = " + rateLimitCount +
            ", lastFileId = " + lastFileId +
            ", lastAccessAt = " + lastAccessAt +
            ", banUntil = " + banUntil +
            ", permanentBan = " + permanentBan +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
        "}";
    }
}
