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
@TableName("storage_configs")
public class StorageConfigsEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("name")
    private String name;

    @TableField("provider")
    private String provider;

    @TableField("config")
    private String config;

    @TableField("enabled")
    private Boolean enabled;

    @TableField("priority")
    private Integer priority;

    @TableField("is_default")
    private Boolean isDefault;

    @TableField("storage_quota_bytes")
    private Long storageQuotaBytes;

    @TableField("traffic_quota_bytes")
    private Long trafficQuotaBytes;

    @TableField("failover_threshold_pct")
    private Short failoverThresholdPct;

    @TableField("auto_failover")
    private Boolean autoFailover;

    @TableField("manual_storage_bytes")
    private Long manualStorageBytes;

    @TableField("manual_traffic_bytes")
    private Long manualTrafficBytes;

    @TableField("last_usage")
    private String lastUsage;

    @TableField("last_health")
    private String lastHealth;

    @TableField("last_health_at")
    private OffsetDateTime lastHealthAt;

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

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public String getConfig() {
        return config;
    }

    public void setConfig(String config) {
        this.config = config;
    }

    public Boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(Boolean enabled) {
        this.enabled = enabled;
    }

    public Integer getPriority() {
        return priority;
    }

    public void setPriority(Integer priority) {
        this.priority = priority;
    }

    public Boolean getIsDefault() {
        return isDefault;
    }

    public void setIsDefault(Boolean isDefault) {
        this.isDefault = isDefault;
    }

    public Long getStorageQuotaBytes() {
        return storageQuotaBytes;
    }

    public void setStorageQuotaBytes(Long storageQuotaBytes) {
        this.storageQuotaBytes = storageQuotaBytes;
    }

    public Long getTrafficQuotaBytes() {
        return trafficQuotaBytes;
    }

    public void setTrafficQuotaBytes(Long trafficQuotaBytes) {
        this.trafficQuotaBytes = trafficQuotaBytes;
    }

    public Short getFailoverThresholdPct() {
        return failoverThresholdPct;
    }

    public void setFailoverThresholdPct(Short failoverThresholdPct) {
        this.failoverThresholdPct = failoverThresholdPct;
    }

    public Boolean getAutoFailover() {
        return autoFailover;
    }

    public void setAutoFailover(Boolean autoFailover) {
        this.autoFailover = autoFailover;
    }

    public Long getManualStorageBytes() {
        return manualStorageBytes;
    }

    public void setManualStorageBytes(Long manualStorageBytes) {
        this.manualStorageBytes = manualStorageBytes;
    }

    public Long getManualTrafficBytes() {
        return manualTrafficBytes;
    }

    public void setManualTrafficBytes(Long manualTrafficBytes) {
        this.manualTrafficBytes = manualTrafficBytes;
    }

    public String getLastUsage() {
        return lastUsage;
    }

    public void setLastUsage(String lastUsage) {
        this.lastUsage = lastUsage;
    }

    public String getLastHealth() {
        return lastHealth;
    }

    public void setLastHealth(String lastHealth) {
        this.lastHealth = lastHealth;
    }

    public OffsetDateTime getLastHealthAt() {
        return lastHealthAt;
    }

    public void setLastHealthAt(OffsetDateTime lastHealthAt) {
        this.lastHealthAt = lastHealthAt;
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
        return "StorageConfigsEntity{" +
            "id = " + id +
            ", name = " + name +
            ", provider = " + provider +
            ", config = " + config +
            ", enabled = " + enabled +
            ", priority = " + priority +
            ", isDefault = " + isDefault +
            ", storageQuotaBytes = " + storageQuotaBytes +
            ", trafficQuotaBytes = " + trafficQuotaBytes +
            ", failoverThresholdPct = " + failoverThresholdPct +
            ", autoFailover = " + autoFailover +
            ", manualStorageBytes = " + manualStorageBytes +
            ", manualTrafficBytes = " + manualTrafficBytes +
            ", lastUsage = " + lastUsage +
            ", lastHealth = " + lastHealth +
            ", lastHealthAt = " + lastHealthAt +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
            ", deletedAt = " + deletedAt +
        "}";
    }
}
