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
@TableName("tasks")
public class TasksEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("project_id")
    private UUID projectId;

    @TableField("type")
    private String type;

    @TableField("status")
    private String status;

    @TableField("priority")
    private Short priority;

    @TableField("progress")
    private Short progress;

    @TableField("payload")
    private String payload;

    @TableField("result")
    private String result;

    @TableField("error")
    private String error;

    @TableField("locked_by")
    private String lockedBy;

    @TableField("locked_until")
    private OffsetDateTime lockedUntil;

    @TableField("run_at")
    private OffsetDateTime runAt;

    @TableField("attempts")
    private Short attempts;

    @TableField("max_attempts")
    private Short maxAttempts;

    @TableField("idempotency_key")
    private String idempotencyKey;

    @TableField("created_by")
    private UUID createdBy;

    @TableField("started_at")
    private OffsetDateTime startedAt;

    @TableField("finished_at")
    private OffsetDateTime finishedAt;

    @TableField("paused_at")
    private OffsetDateTime pausedAt;

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

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Short getPriority() {
        return priority;
    }

    public void setPriority(Short priority) {
        this.priority = priority;
    }

    public Short getProgress() {
        return progress;
    }

    public void setProgress(Short progress) {
        this.progress = progress;
    }

    public String getPayload() {
        return payload;
    }

    public void setPayload(String payload) {
        this.payload = payload;
    }

    public String getResult() {
        return result;
    }

    public void setResult(String result) {
        this.result = result;
    }

    public String getError() {
        return error;
    }

    public void setError(String error) {
        this.error = error;
    }

    public String getLockedBy() {
        return lockedBy;
    }

    public void setLockedBy(String lockedBy) {
        this.lockedBy = lockedBy;
    }

    public OffsetDateTime getLockedUntil() {
        return lockedUntil;
    }

    public void setLockedUntil(OffsetDateTime lockedUntil) {
        this.lockedUntil = lockedUntil;
    }

    public OffsetDateTime getRunAt() {
        return runAt;
    }

    public void setRunAt(OffsetDateTime runAt) {
        this.runAt = runAt;
    }

    public Short getAttempts() {
        return attempts;
    }

    public void setAttempts(Short attempts) {
        this.attempts = attempts;
    }

    public Short getMaxAttempts() {
        return maxAttempts;
    }

    public void setMaxAttempts(Short maxAttempts) {
        this.maxAttempts = maxAttempts;
    }

    public String getIdempotencyKey() {
        return idempotencyKey;
    }

    public void setIdempotencyKey(String idempotencyKey) {
        this.idempotencyKey = idempotencyKey;
    }

    public UUID getCreatedBy() {
        return createdBy;
    }

    public void setCreatedBy(UUID createdBy) {
        this.createdBy = createdBy;
    }

    public OffsetDateTime getStartedAt() {
        return startedAt;
    }

    public void setStartedAt(OffsetDateTime startedAt) {
        this.startedAt = startedAt;
    }

    public OffsetDateTime getFinishedAt() {
        return finishedAt;
    }

    public void setFinishedAt(OffsetDateTime finishedAt) {
        this.finishedAt = finishedAt;
    }

    public OffsetDateTime getPausedAt() {
        return pausedAt;
    }

    public void setPausedAt(OffsetDateTime pausedAt) {
        this.pausedAt = pausedAt;
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
        return "TasksEntity{" +
            "id = " + id +
            ", projectId = " + projectId +
            ", type = " + type +
            ", status = " + status +
            ", priority = " + priority +
            ", progress = " + progress +
            ", payload = " + payload +
            ", result = " + result +
            ", error = " + error +
            ", lockedBy = " + lockedBy +
            ", lockedUntil = " + lockedUntil +
            ", runAt = " + runAt +
            ", attempts = " + attempts +
            ", maxAttempts = " + maxAttempts +
            ", idempotencyKey = " + idempotencyKey +
            ", createdBy = " + createdBy +
            ", startedAt = " + startedAt +
            ", finishedAt = " + finishedAt +
            ", pausedAt = " + pausedAt +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
            ", deletedAt = " + deletedAt +
        "}";
    }
}
