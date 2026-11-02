package com.ufm.share;

import org.apache.ibatis.annotations.*;
import java.util.*;

@Mapper
public interface ShareMapper {
    @Insert("""
        INSERT INTO share_links(id,file_id,token,custom_path,password_hash,expires_at,max_downloads,preview_only,allowed_ips,watermark)
        VALUES(#{id},#{file},#{token},#{input.customPath},#{password},#{input.expiresAt},#{input.maxDownloads},#{input.previewOnly},CAST(#{ips} AS jsonb),#{input.watermark})
        """)
    int createFile(UUID id,UUID file,String token,String password,String ips,ShareDtos.Input input);
    @Insert("""
        INSERT INTO folder_share_links(id,folder_id,token,custom_path,password_hash,expires_at,max_downloads,preview_only,allowed_ips,watermark)
        VALUES(#{id},#{folder},#{token},#{input.customPath},#{password},#{input.expiresAt},#{input.maxDownloads},#{input.previewOnly},CAST(#{ips} AS jsonb),#{input.watermark})
        """)
    int createFolder(UUID id,UUID folder,String token,String password,String ips,ShareDtos.Input input);
    @Select("""
        SELECT id,file_id,NULL::uuid AS folder_id,token,custom_path,password_hash,expires_at,max_downloads,download_count,
          preview_only,allowed_ips::text,watermark,enabled,deleted_at FROM share_links WHERE id=#{id}
        """) ShareRow file(UUID id);
    @Select("""
        SELECT id,NULL::uuid AS file_id,folder_id,token,custom_path,password_hash,expires_at,max_downloads,download_count,
          preview_only,allowed_ips::text,watermark,enabled,deleted_at FROM folder_share_links WHERE id=#{id}
        """) ShareRow folder(UUID id);
    @Select("""
        SELECT id,file_id,NULL::uuid AS folder_id,token,custom_path,password_hash,expires_at,max_downloads,download_count,
          preview_only,allowed_ips::text,watermark,enabled,deleted_at FROM share_links WHERE token=#{token} OR custom_path=#{token} FOR UPDATE
        """) ShareRow publicFile(String token);
    @Select("""
        SELECT id,NULL::uuid AS file_id,folder_id,token,custom_path,password_hash,expires_at,max_downloads,download_count,
          preview_only,allowed_ips::text,watermark,enabled,deleted_at FROM folder_share_links WHERE token=#{token} OR custom_path=#{token} FOR UPDATE
        """) ShareRow publicFolder(String token);
    @Select("""
        SELECT id,file_id,NULL::uuid AS folder_id,token,custom_path,password_hash,expires_at,max_downloads,download_count,
          preview_only,allowed_ips::text,watermark,enabled,deleted_at FROM share_links WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500
        """) List<ShareRow> files();
    @Select("""
        SELECT id,NULL::uuid AS file_id,folder_id,token,custom_path,password_hash,expires_at,max_downloads,download_count,
          preview_only,allowed_ips::text,watermark,enabled,deleted_at FROM folder_share_links WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500
        """) List<ShareRow> folders();
    @Update("UPDATE share_links SET enabled=false,deleted_at=now() WHERE id=#{id}") int disableFile(UUID id);
    @Update("UPDATE folder_share_links SET enabled=false,deleted_at=now() WHERE id=#{id}") int disableFolder(UUID id);
    @Update("UPDATE share_links SET download_count=download_count+1 WHERE id=#{id}") int countFile(UUID id);
    @Update("UPDATE folder_share_links SET download_count=download_count+1 WHERE id=#{id}") int countFolder(UUID id);
    @Update("UPDATE share_links SET enabled=coalesce(#{input.enabled},enabled),preview_only=coalesce(#{input.previewOnly},preview_only),expires_at=coalesce(#{input.expiresAt},expires_at),max_downloads=coalesce(#{input.maxDownloads},max_downloads),watermark=coalesce(#{input.watermark},watermark),password_hash=coalesce(#{password},password_hash) WHERE id=#{id}")
    int editFile(UUID id,ShareDtos.Edit input,String password);
    @Update("UPDATE folder_share_links SET enabled=coalesce(#{input.enabled},enabled),preview_only=coalesce(#{input.previewOnly},preview_only),expires_at=coalesce(#{input.expiresAt},expires_at),max_downloads=coalesce(#{input.maxDownloads},max_downloads),watermark=coalesce(#{input.watermark},watermark),password_hash=coalesce(#{password},password_hash) WHERE id=#{id}")
    int editFolder(UUID id,ShareDtos.Edit input,String password);
    @Update("UPDATE share_links SET password_hash=CASE WHEN #{input.removePassword} THEN NULL ELSE password_hash END,expires_at=CASE WHEN #{input.clearExpiration} THEN NULL ELSE expires_at END,max_downloads=CASE WHEN #{input.clearDownloadLimit} THEN NULL ELSE max_downloads END,allowed_ips=coalesce(CAST(#{ips} AS jsonb),allowed_ips) WHERE id=#{id}")
    int clearFilePolicy(UUID id,ShareDtos.Edit input,String ips);
    @Update("UPDATE folder_share_links SET password_hash=CASE WHEN #{input.removePassword} THEN NULL ELSE password_hash END,expires_at=CASE WHEN #{input.clearExpiration} THEN NULL ELSE expires_at END,max_downloads=CASE WHEN #{input.clearDownloadLimit} THEN NULL ELSE max_downloads END,allowed_ips=coalesce(CAST(#{ips} AS jsonb),allowed_ips) WHERE id=#{id}")
    int clearFolderPolicy(UUID id,ShareDtos.Edit input,String ips);
    @Select("SELECT id,project_id,path FROM folders WHERE id=#{id} AND deleted_at IS NULL") com.ufm.file.FileDtos.Folder folderInfo(UUID id);
    @Select("SELECT id FROM files WHERE project_id=#{project} AND starts_with(folder_path,#{path}) AND status='ACTIVE' AND deleted_at IS NULL ORDER BY original_name LIMIT 200")
    List<UUID> folderFiles(UUID project,String path);
    @Select("""
        SELECT DISTINCT split_part(substring(path FROM length(#{path})+1),'/',1) AS name
          FROM folders WHERE project_id=#{project} AND starts_with(path,#{path}) AND path<>#{path} AND deleted_at IS NULL
        UNION SELECT DISTINCT split_part(substring(folder_path FROM length(#{path})+1),'/',1) AS name
          FROM files WHERE project_id=#{project} AND starts_with(folder_path,#{path}) AND folder_path<>#{path} AND status='ACTIVE' AND deleted_at IS NULL
        ORDER BY name LIMIT 1000
        """) List<String> childFolders(UUID project,String path);
    @Select("""
        SELECT id FROM files WHERE project_id=#{project} AND folder_path=#{path} AND status='ACTIVE' AND deleted_at IS NULL
        ORDER BY CASE WHEN #{sort}='name' THEN original_name END ASC,
          CASE WHEN #{sort}='size' THEN size END DESC, CASE WHEN #{sort}='recent' THEN created_at END DESC,id
        LIMIT #{size} OFFSET #{offset}
        """) List<UUID> folderPage(UUID project,String path,String sort,int size,long offset);
    @Select("SELECT count(*) FROM files WHERE project_id=#{project} AND folder_path=#{path} AND status='ACTIVE' AND deleted_at IS NULL")
    long folderCount(UUID project,String path);
    @Update("UPDATE projects SET library_enabled=#{enabled},library_slug=#{slug} WHERE id=#{project}") int library(UUID project,boolean enabled,String slug);
    @Select("SELECT id FROM projects WHERE library_slug=#{slug} AND library_enabled AND deleted_at IS NULL") UUID libraryProject(String slug);
    String PUBLIC_WHERE=" FROM files f WHERE f.project_id=#{project} AND (f.is_public OR EXISTS(SELECT 1 FROM folder_public_policies p WHERE p.project_id=f.project_id AND starts_with(f.folder_path,p.folder_path) AND p.is_public AND p.deleted_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now()))) AND f.status='ACTIVE' AND f.deleted_at IS NULL AND (#{query}='' OR f.content_tsv @@ plainto_tsquery('simple',#{query})) ";
    @Select("SELECT f.id"+PUBLIC_WHERE+"ORDER BY f.created_at DESC,f.id LIMIT #{size} OFFSET #{offset}")
    List<UUID> publicSearch(UUID project,String query,int size,long offset);
    @Select("SELECT count(*)"+PUBLIC_WHERE) long publicCount(UUID project,String query);
    @Select("SELECT f.id FROM files f WHERE f.project_id=#{project} AND (f.is_public OR EXISTS(SELECT 1 FROM folder_public_policies p WHERE p.project_id=f.project_id AND starts_with(f.folder_path,p.folder_path) AND p.is_public AND p.deleted_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now()))) AND f.status='ACTIVE' AND f.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT 200") List<UUID> publicFiles(UUID project);
    @Select("SELECT EXISTS(SELECT 1 FROM files f WHERE f.id=#{id} AND (f.is_public OR EXISTS(SELECT 1 FROM folder_public_policies p WHERE p.project_id=f.project_id AND starts_with(f.folder_path,p.folder_path) AND p.is_public AND p.deleted_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now()))))") boolean published(UUID id);
    @Insert("INSERT INTO folder_public_policies(project_id,folder_path,is_public) VALUES(#{project},#{path},#{published}) ON CONFLICT(project_id,folder_path) DO UPDATE SET is_public=excluded.is_public,deleted_at=NULL") int publish(UUID project,String path,boolean published);
    @Update("UPDATE folder_public_policies SET deleted_at=now() WHERE project_id=#{project} AND folder_path=#{path}") int unpublish(UUID project,String path);
    @Select("SELECT project_id,folder_path,is_public,expires_at FROM folder_public_policies WHERE project_id=#{project} AND deleted_at IS NULL") List<Map<String,Object>> policies(UUID project);
}
