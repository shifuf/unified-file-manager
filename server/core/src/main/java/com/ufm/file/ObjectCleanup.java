package com.ufm.file;

import com.ufm.project.ProjectMapper;
import com.ufm.storage.ObjectStore;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;
import java.util.*;

@Service
public class ObjectCleanup {
    private final FileMapper files;
    private final ProjectMapper projects;
    private final ObjectStore objects;
    @org.springframework.beans.factory.annotation.Autowired private UploadMapper uploads;
    @org.springframework.beans.factory.annotation.Autowired private com.fasterxml.jackson.databind.ObjectMapper json;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.task.TaskMapper tasks;
    public ObjectCleanup(FileMapper files,ProjectMapper projects,ObjectStore objects) {
        this.files=files; this.projects=projects; this.objects=objects;
    }
    @Transactional(propagation=Propagation.REQUIRES_NEW)
    public void execute(UUID task,UUID project,List<FileMapper.ObjectRef> candidates) {
        // Match ingest's project lock so no new duplicate reference can race deletion.
        projects.lock(project);
        for (var object:candidates) if (!files.referenced(object.storageConfigId(),object.storageKey()))
            objects.remove(object.storageConfigId(),object.storageKey());
        files.cleanupDone(task);
    }
    @Transactional(propagation=Propagation.REQUIRES_NEW)
    public void scheduleSealed(UUID project,UUID storage,String key) {
        UUID task=UUID.randomUUID();
        try { files.cleanupTask(task,project,json.writeValueAsString(Map.of("objects",List.of(new FileMapper.ObjectRef(storage,key))))); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        files.deferCleanup(task,960);
    }
    @Transactional(propagation=Propagation.REQUIRES_NEW)
    public void scheduleMigration(UUID project,UUID storage,String key,UUID migration,String worker) {
        UUID task=UUID.randomUUID();
        try { files.cleanupTask(task,project,json.writeValueAsString(Map.of("objects",List.of(new FileMapper.ObjectRef(storage,key)),
                "migrationTaskId",migration.toString(),"migrationWorker",worker))); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        files.deferCleanup(task,960);
    }
    @Transactional(propagation=Propagation.REQUIRES_NEW)
    public void executePayload(UUID task,UUID project,com.fasterxml.jackson.databind.JsonNode payload) throws java.io.IOException {
        if (payload.hasNonNull("migrationTaskId")) {
            projects.lock(project);
            var owner=tasks.lock(UUID.fromString(payload.path("migrationTaskId").asText()));
            if (owner!=null && "RUNNING".equals(owner.getStatus()) && payload.path("migrationWorker").asText().equals(owner.getLockedBy())
                    && owner.getLockedUntil()!=null && owner.getLockedUntil().isAfter(java.time.OffsetDateTime.now())) {
                files.releaseCleanup(task); return;
            }
        }
        String manifest=payload.path("manifest").asText("");
        if (!manifest.isEmpty()) {
            uploads.lock(payload.path("sessionId").asText());
            String value=uploads.manifest(manifest);
            if (value!=null && manifest.startsWith("multipart.")) {
                var session=json.readValue(value,DirectUploadService.MultipartSession.class);
                objects.abort(session.session().storageId(),session.session().key(),session.uploadId());
            }
        }
        execute(task,project,json.readerForListOf(FileMapper.ObjectRef.class).readValue(payload.path("objects")));
        if (!manifest.isEmpty()) uploads.remove(manifest);
    }
}
