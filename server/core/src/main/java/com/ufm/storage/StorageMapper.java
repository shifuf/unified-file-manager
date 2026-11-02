package com.ufm.storage;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.ufm.generated.entity.StorageConfigsEntity;
import org.apache.ibatis.annotations.*;
import java.util.UUID;

@Mapper
public interface StorageMapper extends BaseMapper<StorageConfigsEntity> {
    @Select("SELECT s.* FROM storage_configs s JOIN project_storage p ON p.config_id=s.id WHERE p.project_id=#{project} AND p.deleted_at IS NULL AND s.deleted_at IS NULL AND s.enabled AND s.id<>#{current} ORDER BY p.priority,s.priority,s.id")
    java.util.List<StorageConfigsEntity> candidates(UUID project,UUID current);
    @Update("UPDATE storage_configs SET priority=#{p.priority},storage_quota_bytes=#{p.storageQuotaBytes},traffic_quota_bytes=#{p.trafficQuotaBytes},failover_threshold_pct=#{p.threshold},auto_failover=#{p.autoFailover},manual_storage_bytes=#{p.manualStorageBytes},manual_traffic_bytes=#{p.manualTrafficBytes} WHERE id=#{id}")
    int policy(UUID id,StorageDtos.Policy p);
    @Select("SELECT project_id FROM project_storage WHERE config_id=#{id} AND deleted_at IS NULL") java.util.List<UUID> projects(UUID id);
    @Update("UPDATE storage_configs SET config=CAST(#{config} AS jsonb) WHERE id=#{id}")
    int config(UUID id,String config);
    @Update("UPDATE storage_configs SET last_usage=CAST(#{usage} AS jsonb),last_health=CAST(#{health} AS jsonb) WHERE id=#{id}")
    int snapshot(UUID id,String usage,String health);
    @Update("SELECT pg_advisory_xact_lock(8462418)") void lockDefaults();
    @Update("UPDATE storage_configs SET is_default=false WHERE is_default") int clearDefault();
    @Select("SELECT id FROM storage_configs WHERE is_default AND enabled AND deleted_at IS NULL LIMIT 1")
    UUID defaultEnabledId();
    @Select("SELECT EXISTS(SELECT 1 FROM project_storage WHERE config_id=#{id} AND deleted_at IS NULL)")
    boolean bound(UUID id);
    @Update("UPDATE storage_configs SET name=#{name} WHERE id=#{id}") int rename(UUID id,String name);
    @Update("UPDATE storage_configs SET deleted_at=now(),is_default=false WHERE id=#{id}") int softDelete(UUID id);
}
