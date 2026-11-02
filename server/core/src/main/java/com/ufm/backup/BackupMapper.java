package com.ufm.backup;

import org.apache.ibatis.annotations.*;
import java.util.*;

@Mapper
public interface BackupMapper {
    record Row(UUID id,String status,boolean includeObjects,String fileName,Long size,String checksum,String storagePath,String error) {}
    record ObjectRef(UUID storageConfigId,String storageKey) {}
    @Insert("INSERT INTO backups(id,include_objects,file_name) VALUES(#{id},#{objects},#{name})") int create(UUID id,boolean objects,String name);
    @Select("SELECT id,status,include_objects,file_name,size,checksum,storage_path,error FROM backups WHERE id=#{id} AND deleted_at IS NULL") Row get(UUID id);
    @Select("SELECT id,status,include_objects,file_name,size,checksum,storage_path,error FROM backups WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200") List<Row> list();
    @Update("UPDATE backups SET status='RUNNING',started_at=now() WHERE id=#{id}") int start(UUID id);
    @Update("UPDATE backups SET status='DONE',size=#{size},checksum=#{checksum},storage_path=#{path},finished_at=now() WHERE id=#{id}")
    int done(UUID id,long size,String checksum,String path);
    @Update("UPDATE backups SET deleted_at=now() WHERE id=#{id}") int delete(UUID id);
    @Select("SELECT EXISTS(SELECT 1 FROM tasks WHERE type IN ('BACKUP','PROJECT_IMPORT') AND status IN ('PENDING','RUNNING','PAUSED') AND payload->>'backupId'=CAST(#{id} AS text))") boolean busy(UUID id);
    @Select("""
        SELECT DISTINCT storage_config_id,storage_key FROM files WHERE deleted_at IS NULL
        UNION SELECT storage_config_id,storage_key FROM file_versions WHERE deleted_at IS NULL
        UNION SELECT storage_config_id,storage_key FROM file_derivatives WHERE status='READY' AND deleted_at IS NULL
        UNION SELECT d.storage_config_id,(d.metadata->>'prefix')||'/'||replace(a.name,'.','_')
          FROM file_derivatives d CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(d.metadata->'assets','[]'::jsonb)) a(name)
          WHERE d.kind='HLS' AND d.status='READY' AND d.deleted_at IS NULL
        """)
    List<ObjectRef> objects();
}
