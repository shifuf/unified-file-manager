package com.ufm.task;

import com.ufm.file.FileMapper;
import com.ufm.file.FileService;
import com.ufm.generated.entity.FilesEntity;
import com.ufm.project.ProjectMapper;
import org.apache.ibatis.annotations.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.OffsetDateTime;
import java.util.*;

@Service
public class MigrationPublication {
    public record Attachment(UUID id,String kind,UUID storage,String key,String metadata,OffsetDateTime updatedAt) {}
    public record Snapshot(FilesEntity file,List<Attachment> attachments) {}
    public record Replacement(Attachment source,String key,String metadata) {}
    @Mapper
    public interface Queries {
        @Select("""
            SELECT id,'VERSION' AS kind,storage_config_id AS storage,storage_key AS key,'{}' AS metadata,updated_at
              FROM file_versions WHERE file_id=#{file} AND deleted_at IS NULL
            UNION ALL
            SELECT id,kind,storage_config_id,storage_key,metadata::text,updated_at
              FROM file_derivatives WHERE file_id=#{file} AND deleted_at IS NULL
            ORDER BY kind,id
            """) List<Attachment> attachments(UUID file);
        @Update("UPDATE file_versions SET storage_config_id=#{storage},storage_key=#{key} WHERE id=#{id}")
        int version(UUID id,UUID storage,String key);
        @Update("UPDATE file_derivatives SET storage_config_id=#{storage},storage_key=#{key},metadata=CAST(#{metadata} AS jsonb) WHERE id=#{id}")
        int derivative(UUID id,UUID storage,String key,String metadata);
    }
    private final Queries queries;
    private final FileService service;
    private final FileMapper files;
    private final ProjectMapper projects;
    private final TaskMapper tasks;
    public MigrationPublication(Queries queries,FileService service,FileMapper files,ProjectMapper projects,TaskMapper tasks) {
        this.queries=queries; this.service=service; this.files=files; this.projects=projects; this.tasks=tasks;
    }
    @Transactional
    public Snapshot snapshot(UUID file) {
        var before=service.require(file,false);
        projects.lock(before.getProjectId());
        return new Snapshot(service.require(file,false),queries.attachments(file));
    }
    @Transactional
    public boolean publish(Snapshot snapshot,UUID target,String key,List<Replacement> replacements,UUID task,String worker) {
        var source=snapshot.file(); projects.lock(source.getProjectId());
        var owner=tasks.lock(task);
        if (owner==null || !"RUNNING".equals(owner.getStatus()) || !worker.equals(owner.getLockedBy())
                || !source.getProjectId().equals(owner.getProjectId())) return false;
        var current=files.selectById(source.getId());
        if (current==null || current.getDeletedAt()!=null || !"ACTIVE".equals(current.getStatus())
                || !Objects.equals(current.getStorageConfigId(),source.getStorageConfigId())
                || !current.getStorageKey().equals(source.getStorageKey()) || !current.getVersion().equals(source.getVersion())
                || !snapshot.attachments().equals(queries.attachments(source.getId()))) return false;
        var expected=snapshot.attachments().stream().filter(a->!target.equals(a.storage())).toList();
        if (!expected.equals(replacements.stream().map(Replacement::source).toList()))
            throw new IllegalArgumentException("Incomplete migration bundle");
        if (files.migrate(source.getId(),source.getStorageConfigId(),source.getStorageKey(),source.getVersion(),target,key)!=1)
            throw new IllegalStateException("Migration changed after project lock");
        for (var replacement:replacements) {
            var attachment=replacement.source();
            if (attachment.kind().equals("VERSION")) queries.version(attachment.id(),target,replacement.key());
            else queries.derivative(attachment.id(),target,replacement.key(),replacement.metadata());
        }
        return true;
    }
}
