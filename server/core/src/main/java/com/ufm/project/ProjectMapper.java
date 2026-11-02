package com.ufm.project;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.ufm.generated.entity.ProjectsEntity;
import org.apache.ibatis.annotations.*;
import java.util.UUID;

@Mapper
public interface ProjectMapper extends BaseMapper<ProjectsEntity> {
    @Update("UPDATE projects SET notify_enabled=#{enabled} WHERE id=#{id} AND deleted_at IS NULL") int notifications(UUID id,boolean enabled);
    @Select("SELECT * FROM projects WHERE id=#{id} AND deleted_at IS NULL FOR UPDATE")
    ProjectsEntity lock(UUID id);

    @Update("UPDATE projects SET allowed_domains=CAST(#{domains} AS jsonb) WHERE id=#{id}")
    int domains(UUID id,String domains);

    @Update("UPDATE project_storage SET is_active=false WHERE project_id=#{id} AND is_active")
    int deactivate(UUID id);

    @Insert("""
        INSERT INTO project_storage(project_id,config_id,is_active) VALUES(#{projectId},#{configId},#{active})
        ON CONFLICT(project_id,config_id) DO UPDATE SET is_active=excluded.is_active,deleted_at=NULL
        """)
    int bind(UUID projectId,UUID configId,boolean active);

    @Select("SELECT id,project_id,config_id,is_active,priority FROM project_storage WHERE project_id=#{id} AND deleted_at IS NULL ORDER BY priority,id")
    java.util.List<ProjectDtos.Binding> bindings(UUID id);

    @Insert("""
        INSERT INTO project_secrets(project_id,name,secret_hash,secret_enc) VALUES(#{id},'primary',#{hash},#{encrypted})
        ON CONFLICT(project_id,name) DO UPDATE SET secret_hash=excluded.secret_hash,secret_enc=excluded.secret_enc
        """)
    int addSecret(UUID id,String hash,String encrypted);
}
