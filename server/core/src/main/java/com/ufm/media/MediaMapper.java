package com.ufm.media;

import org.apache.ibatis.annotations.*;
import java.util.UUID;

@Mapper
public interface MediaMapper {
    record Derivative(UUID fileId,UUID storageConfigId,String storageKey,String mime,long size,String status) {}
    @Insert("""
        INSERT INTO file_derivatives(file_id,kind,storage_config_id,storage_key,mime,size,status)
        VALUES(#{file},#{kind},#{storage},#{key},#{mime},#{size},'READY')
        ON CONFLICT(file_id,kind) DO UPDATE SET storage_config_id=excluded.storage_config_id,storage_key=excluded.storage_key,
          mime=excluded.mime,size=excluded.size,status='READY'
        """) int derivative(UUID file,String kind,UUID storage,String key,String mime,long size);
    @Select("SELECT file_id,storage_config_id,storage_key,mime,size,status FROM file_derivatives WHERE file_id=#{file} AND kind='THUMB' AND status='READY' AND deleted_at IS NULL")
    Derivative thumbnail(UUID file);
    @Select("SELECT file_id,storage_config_id,storage_key,mime,size,status FROM file_derivatives WHERE file_id=#{file} AND kind=#{kind} AND status='READY' AND deleted_at IS NULL")
    Derivative derivativeInfo(UUID file,String kind);
    @Update("UPDATE file_derivatives SET metadata=CAST(#{metadata} AS jsonb) WHERE file_id=#{file} AND kind='HLS'")
    int saveHlsMetadata(UUID file,String metadata);
    @Select("SELECT metadata::text FROM file_derivatives WHERE file_id=#{file} AND kind='HLS' AND status='READY' AND deleted_at IS NULL")
    String hlsMetadata(UUID file);
    @Update("UPDATE file_derivatives SET metadata=CAST(#{metadata} AS jsonb),deleted_at=NULL WHERE file_id=#{file} AND kind=#{kind}")
    int metadata(UUID file,String kind,String metadata);
    @Select("SELECT storage_config_id,storage_key FROM file_derivatives WHERE file_id=#{file} AND kind=#{kind} UNION SELECT d.storage_config_id,(d.metadata->>'prefix')||'/'||replace(a.name,'.','_') FROM file_derivatives d CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(d.metadata->'assets','[]'::jsonb)) a(name) WHERE d.file_id=#{file} AND d.kind=#{kind} AND d.kind='HLS'")
    java.util.List<com.ufm.file.FileMapper.ObjectRef> objectsForKind(UUID file,String kind);
}
