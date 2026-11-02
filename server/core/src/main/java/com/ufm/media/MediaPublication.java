package com.ufm.media;

import com.ufm.file.FileMapper;
import com.ufm.generated.entity.FilesEntity;
import com.ufm.project.ProjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;

@Service
public class MediaPublication {
    private final FileMapper files;
    private final ProjectMapper projects;
    private final MediaMapper media;
    private final ObjectMapper json;
    public MediaPublication(FileMapper files,ProjectMapper projects,MediaMapper media,ObjectMapper json) {
        this.files=files; this.projects=projects; this.media=media; this.json=json;
    }
    @Transactional
    public boolean publish(FilesEntity source,String kind,String key,String mime,long size,String metadata,List<FileMapper.ObjectRef> created) {
        projects.lock(source.getProjectId()); var current=files.selectById(source.getId());
        boolean valid=current!=null && current.getDeletedAt()==null && current.getStatus().equals("ACTIVE")
                && current.getVersion().equals(source.getVersion()) && current.getStorageKey().equals(source.getStorageKey());
        if (valid) {
            defer(source.getProjectId(),media.objectsForKind(source.getId(),kind));
            media.derivative(source.getId(),kind,source.getStorageConfigId(),key,mime,size);
            media.metadata(source.getId(),kind,metadata);
        } else defer(source.getProjectId(),created);
        return valid;
    }
    private void defer(UUID project,List<FileMapper.ObjectRef> refs) {
        if (refs.isEmpty()) return;
        try { files.cleanupTask(UUID.randomUUID(),project,json.writeValueAsString(Map.of("objects",refs))); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
}
