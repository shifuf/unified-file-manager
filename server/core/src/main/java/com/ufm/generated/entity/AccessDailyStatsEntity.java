package com.ufm.generated.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.io.Serializable;
import java.time.LocalDate;
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
@TableName("access_daily_stats")
public class AccessDailyStatsEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("day")
    private LocalDate day;

    @TableField("project_id")
    private UUID projectId;

    @TableField("file_id")
    private UUID fileId;

    @TableField("referer_host")
    private String refererHost;

    @TableField("access_count")
    private Long accessCount;

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

    public LocalDate getDay() {
        return day;
    }

    public void setDay(LocalDate day) {
        this.day = day;
    }

    public UUID getProjectId() {
        return projectId;
    }

    public void setProjectId(UUID projectId) {
        this.projectId = projectId;
    }

    public UUID getFileId() {
        return fileId;
    }

    public void setFileId(UUID fileId) {
        this.fileId = fileId;
    }

    public String getRefererHost() {
        return refererHost;
    }

    public void setRefererHost(String refererHost) {
        this.refererHost = refererHost;
    }

    public Long getAccessCount() {
        return accessCount;
    }

    public void setAccessCount(Long accessCount) {
        this.accessCount = accessCount;
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
        return "AccessDailyStatsEntity{" +
            "id = " + id +
            ", day = " + day +
            ", projectId = " + projectId +
            ", fileId = " + fileId +
            ", refererHost = " + refererHost +
            ", accessCount = " + accessCount +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
        "}";
    }
}
