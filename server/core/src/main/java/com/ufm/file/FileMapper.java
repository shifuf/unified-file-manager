package com.ufm.file;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.ufm.generated.entity.FilesEntity;
import org.apache.ibatis.annotations.*;
import java.util.*;

@Mapper
public interface FileMapper extends BaseMapper<FilesEntity> {
    @Select("SELECT * FROM files WHERE project_id=#{project} AND folder_path=#{folder} AND original_name=#{name} AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE")
    FilesEntity existing(UUID project,String folder,String name);
    @Select("SELECT config_id FROM project_storage WHERE project_id=#{project} AND is_active AND deleted_at IS NULL")
    UUID activeStorage(UUID project);
    @Select("SELECT * FROM files WHERE project_id=#{project} AND status=#{status} AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT #{limit} OFFSET #{offset}")
    List<FilesEntity> list(UUID project,String status,int limit,int offset);
    String FILTER=" FROM files WHERE project_id=#{project} AND status=#{status} AND deleted_at IS NULL "
            +"AND (CAST(#{folder} AS text) IS NULL OR folder_path=#{folder}) "
            +"AND (CAST(#{category} AS text) IS NULL OR category=#{category}) "
            +"AND (CAST(#{tag} AS text) IS NULL OR tags @> jsonb_build_array(CAST(#{tag} AS text))) "
            +"AND (CAST(#{note} AS text) IS NULL OR strpos(lower(coalesce(note,'')),lower(#{note}))>0) ";
    @Select("SELECT *"+FILTER+"ORDER BY created_at DESC,id LIMIT #{limit} OFFSET #{offset}")
    List<FilesEntity> filtered(UUID project,String status,String folder,String category,String tag,String note,int limit,long offset);
    @Select("SELECT count(*)"+FILTER)
    long filteredCount(UUID project,String status,String folder,String category,String tag,String note);
    @Select("SELECT * FROM files WHERE project_id=#{project} AND status='ACTIVE' AND deleted_at IS NULL AND content_tsv @@ plainto_tsquery('simple',#{query}) ORDER BY ts_rank(content_tsv,plainto_tsquery('simple',#{query})) DESC LIMIT 100")
    List<FilesEntity> search(UUID project,String query);
    @Update("UPDATE projects SET used_bytes=used_bytes+#{bytes},used_files=used_files+#{count} WHERE id=#{project}")
    int quota(UUID project,long bytes,long count);
    @Insert("INSERT INTO folders(project_id,path) VALUES(#{project},#{path}) ON CONFLICT(project_id,path) DO UPDATE SET deleted_at=NULL")
    int folder(UUID project,String path);
    @Select("SELECT id,project_id,path FROM folders WHERE project_id=#{project} AND deleted_at IS NULL ORDER BY path LIMIT 10000")
    List<FileDtos.Folder> folders(UUID project);
    @Insert("""
        INSERT INTO file_versions(file_id,version,original_name,storage_config_id,storage_key,mime,ext,size,checksum)
        SELECT id,version,original_name,storage_config_id,storage_key,mime,ext,size,checksum FROM files WHERE id=#{id}
        """)
    int snapshot(UUID id);
    @Select("SELECT id,version,original_name,size,checksum,created_at FROM file_versions WHERE file_id=#{file} AND deleted_at IS NULL ORDER BY version DESC")
    List<FileDtos.Version> versions(UUID file);
    @Select("SELECT * FROM file_versions WHERE id=#{id}")
    com.ufm.generated.entity.FileVersionsEntity version(UUID id);
    @Update("""
        UPDATE files SET storage_config_id=#{storage},storage_key=#{key},mime=#{mime},category=#{category},ext=#{ext},size=#{size},
          checksum=#{checksum},version=version+1,content_text=#{content},search_text=#{search} WHERE id=#{id}
        """)
    int replace(UUID id,UUID storage,String key,String mime,String category,String ext,long size,String checksum,String content,String search);
    @Update("UPDATE files SET status=#{status},purge_at=CASE WHEN #{status}='RECYCLED' THEN now()+COALESCE((SELECT (value->>'recycleDays')::int FROM settings WHERE key='global'),30)*interval '1 day' ELSE NULL END WHERE id=#{id}")
    int status(UUID id,String status);
    @Update("UPDATE files SET deleted_at=now(),status='DELETED' WHERE id=#{id}") int purge(UUID id);
    @Update("UPDATE files SET original_name=#{name},folder_path=#{folder},is_public=#{isPublic} WHERE id=#{id}")
    int edit(UUID id,String name,String folder,boolean isPublic);
    @Select("SELECT * FROM files WHERE project_id=#{project} AND checksum=#{checksum} AND size=#{size} AND status='ACTIVE' AND deleted_at IS NULL LIMIT 1")
    FilesEntity duplicate(UUID project,String checksum,long size);
    @Update("UPDATE files SET tags=CAST(#{tags} AS jsonb),note=#{note} WHERE id=#{id}") int metadata(UUID id,String tags,String note);
    @Update("UPDATE files SET folder_path=#{target}||substring(folder_path FROM length(#{source})+1) WHERE project_id=#{project} AND starts_with(folder_path,#{source}) AND deleted_at IS NULL")
    int moveFiles(UUID project,String source,String target);
    @Update("UPDATE folders SET path=#{target}||substring(path FROM length(#{source})+1) WHERE project_id=#{project} AND starts_with(path,#{source}) AND deleted_at IS NULL")
    int moveFolders(UUID project,String source,String target);
    @Update("UPDATE files SET storage_config_id=#{target},storage_key=#{key} WHERE id=#{id} AND storage_config_id=#{source} AND storage_key=#{sourceKey} AND version=#{version} AND deleted_at IS NULL AND status='ACTIVE'")
    int migrate(UUID id,UUID source,String sourceKey,int version,UUID target,String key);
    @Insert("INSERT INTO tasks(project_id,type,payload,idempotency_key) VALUES(#{project},'MEDIA_IMAGE',jsonb_build_object('fileId',CAST(#{id} AS text)),CAST(#{id} AS text)||':'||#{version}) ON CONFLICT DO NOTHING")
    int imageTask(UUID project,UUID id,int version);
    @Insert("INSERT INTO tasks(project_id,type,payload,idempotency_key) VALUES(#{project},'MEDIA_VIDEO',jsonb_build_object('fileId',CAST(#{id} AS text)),CAST(#{id} AS text)||':'||#{version}) ON CONFLICT DO NOTHING")
    int videoTask(UUID project,UUID id,int version);
    @Insert("INSERT INTO tasks(project_id,type,payload,idempotency_key) VALUES(#{project},'SEARCH_INDEX',jsonb_build_object('fileId',CAST(#{id} AS text)),CAST(#{id} AS text)||':'||#{version}) ON CONFLICT DO NOTHING")
    int searchTask(UUID project,UUID id,int version);
    @Insert("INSERT INTO tasks(project_id,type,payload,idempotency_key) VALUES(#{project},'SEARCH_INDEX',jsonb_build_object('fileId',CAST(#{id} AS text),'inspect',true,'version',#{version},'key',#{key}),CAST(#{id} AS text)||':'||#{version}) ON CONFLICT DO NOTHING")
    int inspectTask(UUID project,UUID id,int version,String key);
    @Update("UPDATE files SET mime=#{mime},category=#{category},checksum=#{checksum},content_text=#{content},search_text=#{search} WHERE id=#{id} AND version=#{version} AND storage_key=#{key} AND status='ACTIVE' AND deleted_at IS NULL")
    int inspected(UUID id,int version,String key,String mime,String category,String checksum,String content,String search);
    @Update("UPDATE files SET status='QUARANTINED',is_public=false WHERE id=#{id} AND version=#{version} AND storage_key=#{key} AND status='ACTIVE' AND deleted_at IS NULL")
    int quarantine(UUID id,int version,String key);
    @Insert("INSERT INTO tasks(id,project_id,type,payload) VALUES(#{id},#{project},'PROJECT_PURGE',CAST(#{payload} AS jsonb))")
    int cleanupTask(UUID id,UUID project,String payload);
    @Update("UPDATE tasks SET run_at=now()+#{seconds}*interval '1 second' WHERE id=#{id} AND type='PROJECT_PURGE'")
    int deferCleanup(UUID id,int seconds);
    @Update("UPDATE tasks SET status='PENDING',locked_by=NULL,locked_until=NULL,attempts=0,run_at=now()+interval '16 minutes' WHERE id=#{id} AND type='PROJECT_PURGE'")
    int releaseCleanup(UUID id);
    @Insert("INSERT INTO tasks(project_id,type,payload) VALUES(#{project},'STORAGE_MIGRATION',jsonb_build_object('targetStorageId',CAST(#{target} AS text)))")
    int migrationTask(UUID project,UUID target);
    @Update("UPDATE tasks SET status='DONE',progress=100,finished_at=now(),locked_by=NULL,locked_until=NULL WHERE id=#{id} AND type='PROJECT_PURGE'")
    int cleanupDone(UUID id);
    @Update("UPDATE files SET content_text=#{content},search_text=#{search} WHERE id=#{id} AND version=#{version} AND storage_key=#{key} AND status='ACTIVE' AND deleted_at IS NULL")
    int searchIndex(UUID id,int version,String key,String content,String search);
    record ObjectRef(UUID storageConfigId,String storageKey) {}
    @Select("SELECT storage_config_id,storage_key FROM file_versions WHERE file_id=#{id}") List<ObjectRef> versionObjects(UUID id);
    @Delete("DELETE FROM file_versions WHERE file_id=#{id}") int deleteVersions(UUID id);
    @Select("""
        SELECT storage_config_id,storage_key FROM file_derivatives WHERE file_id=#{id} AND deleted_at IS NULL
        UNION SELECT d.storage_config_id,(d.metadata->>'prefix')||'/'||replace(a.name,'.','_')
          FROM file_derivatives d CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(d.metadata->'assets','[]'::jsonb)) a(name)
          WHERE d.file_id=#{id} AND d.kind='HLS' AND d.deleted_at IS NULL
        """) List<ObjectRef> derivativeObjects(UUID id);
    @Delete("DELETE FROM file_derivatives WHERE file_id=#{id}") int deleteDerivatives(UUID id);
    @Select("""
        SELECT EXISTS(SELECT 1 FROM files WHERE storage_config_id=#{storage} AND storage_key=#{key} AND deleted_at IS NULL)
          OR EXISTS(SELECT 1 FROM file_versions WHERE storage_config_id=#{storage} AND storage_key=#{key} AND deleted_at IS NULL)
          OR EXISTS(SELECT 1 FROM file_derivatives WHERE storage_config_id=#{storage} AND storage_key=#{key} AND deleted_at IS NULL)
          OR EXISTS(SELECT 1 FROM file_derivatives d CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(d.metadata->'assets','[]'::jsonb)) a(name)
            WHERE d.storage_config_id=#{storage} AND (d.metadata->>'prefix')||'/'||replace(a.name,'.','_')=#{key} AND d.kind='HLS' AND d.deleted_at IS NULL)
        """) boolean referenced(UUID storage,String key);
}
