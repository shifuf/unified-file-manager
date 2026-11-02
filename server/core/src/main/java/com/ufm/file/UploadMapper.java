package com.ufm.file;

import org.apache.ibatis.annotations.*;
import java.util.UUID;

@Mapper
public interface UploadMapper {
    @Update("SELECT pg_advisory_xact_lock(hashtextextended(#{id},0))") void lock(String id);
    @Select("SELECT value::text FROM settings WHERE key=#{key} FOR UPDATE") String manifest(String key);
    @Select("SELECT value::text FROM settings WHERE key=#{key}") String read(String key);
    @Insert("INSERT INTO settings(key,value) VALUES(#{key},CAST(#{value} AS jsonb)) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    int save(String key,String value);
    @Delete("DELETE FROM settings WHERE key=#{key}") int remove(String key);
    @Insert("""
        INSERT INTO upload_credentials(project_id,token_hash,scope,max_bytes,max_files,expires_at)
        VALUES(#{project},#{hash},CAST(#{scope} AS jsonb),#{maxBytes},#{maxFiles},now()+#{ttl}*interval '1 second')
        """)
    int credential(UUID project,String hash,String scope,long maxBytes,long maxFiles,int ttl);
    @Select("SELECT scope::text FROM upload_credentials WHERE token_hash=#{hash} AND revoked_at IS NULL AND deleted_at IS NULL AND expires_at>now() FOR UPDATE")
    String scope(String hash);
    @Select("SELECT project_id FROM upload_credentials WHERE token_hash=#{hash}") UUID project(String hash);
    @Select("SELECT id,max_bytes,used_bytes,max_files,used_files,expires_at,revoked_at FROM upload_credentials WHERE project_id=#{project} AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200")
    java.util.List<UploadService.CredentialView> credentials(UUID project);
    @Select("SELECT project_id FROM upload_credentials WHERE id=#{id} AND deleted_at IS NULL FOR UPDATE") UUID credentialOwner(UUID id);
    @Update("UPDATE upload_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE id=#{id}") int revoke(UUID id);
    @Update("UPDATE upload_credentials SET used_bytes=used_bytes+#{bytes},used_files=used_files+1 WHERE token_hash=#{hash} AND used_bytes+#{bytes}<=max_bytes AND used_files<max_files")
    int consume(String hash,long bytes);
}
