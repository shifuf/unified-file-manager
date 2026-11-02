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
@TableName("notify_deliveries")
public class NotifyDeliveriesEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("channel_id")
    private UUID channelId;

    @TableField("event")
    private String event;

    @TableField("success")
    private Boolean success;

    @TableField("status_code")
    private Integer statusCode;

    @TableField("error")
    private String error;

    @TableField("attempt")
    private Short attempt;

    @TableField("response_body")
    private String responseBody;

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

    public UUID getChannelId() {
        return channelId;
    }

    public void setChannelId(UUID channelId) {
        this.channelId = channelId;
    }

    public String getEvent() {
        return event;
    }

    public void setEvent(String event) {
        this.event = event;
    }

    public Boolean getSuccess() {
        return success;
    }

    public void setSuccess(Boolean success) {
        this.success = success;
    }

    public Integer getStatusCode() {
        return statusCode;
    }

    public void setStatusCode(Integer statusCode) {
        this.statusCode = statusCode;
    }

    public String getError() {
        return error;
    }

    public void setError(String error) {
        this.error = error;
    }

    public Short getAttempt() {
        return attempt;
    }

    public void setAttempt(Short attempt) {
        this.attempt = attempt;
    }

    public String getResponseBody() {
        return responseBody;
    }

    public void setResponseBody(String responseBody) {
        this.responseBody = responseBody;
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
        return "NotifyDeliveriesEntity{" +
            "id = " + id +
            ", channelId = " + channelId +
            ", event = " + event +
            ", success = " + success +
            ", statusCode = " + statusCode +
            ", error = " + error +
            ", attempt = " + attempt +
            ", responseBody = " + responseBody +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
        "}";
    }
}
