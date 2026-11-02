package com.ufm.task;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.error.*;
import com.ufm.file.*;
import com.ufm.storage.ObjectStore;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

@Service
public class TaskRunner {
    private final TaskMapper mapper;
    private final FileMapper files;
    private final FileService fileService;
    private final ObjectStore objects;
    private final ObjectMapper json;
    private final com.ufm.media.MediaService media;
    private final com.ufm.backup.BackupService backups;
    private final LifecycleService lifecycle;
    private final String worker="worker-"+UUID.randomUUID();
    private long heartbeatMillis=30000;
    @org.springframework.beans.factory.annotation.Autowired private SearchIndexService searchIndex;
    @org.springframework.beans.factory.annotation.Autowired private AutomationService automation;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.notify.NotifyService notify;
    @org.springframework.beans.factory.annotation.Autowired private ObjectCleanup cleanup;
    @org.springframework.beans.factory.annotation.Autowired private UploadService uploads;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.storage.StorageService storageSnapshots;
    @org.springframework.beans.factory.annotation.Autowired private MigrationPublication migrationPublication;
    private com.ufm.common.persistence.MaintenanceGate maintenance;
    @org.springframework.beans.factory.annotation.Autowired
    void setMaintenanceGate(com.ufm.common.persistence.MaintenanceGate gate) { maintenance=gate; }
    @org.springframework.beans.factory.annotation.Value("${ufm.worker.heartbeat-ms:30000}")
    void setHeartbeatMillis(long value) { if (value<10 || value>120000) throw new IllegalArgumentException("Invalid heartbeat interval"); heartbeatMillis=value; }
    public TaskRunner(TaskMapper mapper,FileMapper files,FileService fileService,ObjectStore objects,ObjectMapper json,com.ufm.media.MediaService media,com.ufm.backup.BackupService backups,LifecycleService lifecycle) {
        this.mapper=mapper; this.files=files; this.fileService=fileService; this.objects=objects; this.json=json;
        this.media=media;
        this.backups=backups;
        this.lifecycle=lifecycle;
    }
    public synchronized boolean runOne() {
        com.ufm.common.persistence.MaintenanceGate.Lease access;
        try { access=maintenance==null?()->{}:maintenance.shared(); }
        catch (ApiException ex) { return false; }
        try (access) { return runClaimed(access); }
    }
    private boolean runClaimed(com.ufm.common.persistence.MaintenanceGate.Lease access) {
        var task=mapper.claim(worker); if (task==null) return false;
        if (task.getType().equals("BACKUP") || task.getType().equals("PROJECT_IMPORT")) access.close();
        Thread executing=Thread.currentThread(); AtomicBoolean leaseLost=new AtomicBoolean();
        ScheduledExecutorService lease=Executors.newSingleThreadScheduledExecutor(r->{ Thread t=new Thread(r,"ufm-task-heartbeat"); t.setDaemon(true); return t; });
        // Restore replaces the task table itself. Its exclusive session lock is the lease.
        if (!task.getType().equals("PROJECT_IMPORT")) lease.scheduleWithFixedDelay(()->{
            try {
                if (!mapper.heartbeat(task.getId(),worker)) { leaseLost.set(true); executing.interrupt(); }
            } catch (RuntimeException ex) { leaseLost.set(true); executing.interrupt(); }
        },heartbeatMillis,heartbeatMillis,TimeUnit.MILLISECONDS);
        try {
            switch (task.getType()) {
                case "STORAGE_MIGRATION" -> migrate(task);
                case "PROJECT_PURGE" -> {
                    var payload=json.readTree(task.getPayload());
                    if (payload.has("chunkId")) uploads.expire(UUID.fromString(payload.path("chunkId").asText()));
                    else cleanup.executePayload(task.getId(),task.getProjectId(),payload);
                }
                case "MAINTENANCE" -> { mapper.recover(); lifecycle.maintenance(); automation.cleanExpired(); storageSnapshots.refreshSnapshots(); }
                case "MEDIA_IMAGE" -> media.image(UUID.fromString(json.readTree(task.getPayload()).path("fileId").asText()));
                case "MEDIA_VIDEO" -> media.video(UUID.fromString(json.readTree(task.getPayload()).path("fileId").asText()));
                case "SEARCH_INDEX" -> {
                    var payload=json.readTree(task.getPayload()); UUID id=UUID.fromString(payload.path("fileId").asText());
                    if (payload.path("inspect").asBoolean()) searchIndex.inspect(id,payload.path("version").asInt(),payload.path("key").asText());
                    else searchIndex.index(id);
                }
                case "NOTIFY" -> { var payload=json.readTree(task.getPayload()); notify.deliver(UUID.fromString(payload.path("channelId").asText()),payload.path("event").asText(),payload.path("data")); }
                case "BACKUP" -> backups.execute(UUID.fromString(json.readTree(task.getPayload()).path("backupId").asText()));
                case "PROJECT_IMPORT" -> backups.executeRestore(UUID.fromString(json.readTree(task.getPayload()).path("backupId").asText()));
                case "LIFECYCLE" -> lifecycle.execute(UUID.fromString(json.readTree(task.getPayload()).path("policyId").asText()));
                default -> throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            }
            if (!leaseLost.get()) mapper.done(task.getId(),worker);
        } catch (Exception ex) {
            org.slf4j.LoggerFactory.getLogger(TaskRunner.class).error("Task {} failed",task.getId(),ex);
            mapper.failed(task.getId(),worker,"Task failed; inspect server diagnostics with task id");
        } finally {
            lease.shutdownNow();
            if (leaseLost.get()) Thread.interrupted();
        }
        return true;
    }
    private void migrate(com.ufm.generated.entity.TasksEntity task) throws Exception {
        UUID target=UUID.fromString(json.readTree(task.getPayload()).path("targetStorageId").asText());
        var selected=json.readTree(task.getPayload()).path("fileId");
        long total=selected.isTextual()?1:mapper.remaining(task.getProjectId(),target),processed=0,succeeded=0,failed=0;
        List<Map<String,Object>> failures=new ArrayList<>(); UUID after=null;
        while (true) {
            var current=mapper.selectById(task.getId());
            if (!current.getStatus().equals("RUNNING") || !worker.equals(current.getLockedBy())) return;
            List<UUID> batch=selected.isTextual()?List.of(UUID.fromString(selected.asText())):mapper.migrationAfter(task.getProjectId(),target,after);
            if (batch.isEmpty()) break;
            for (UUID id:batch) {
                current=mapper.selectById(task.getId());
                if (!current.getStatus().equals("RUNNING") || !worker.equals(current.getLockedBy()) || Thread.currentThread().isInterrupted()) return;
                try {
                    var file=fileService.require(id,false);
                    if (!file.getProjectId().equals(task.getProjectId())) throw new ApiException(ErrorCode.FORBIDDEN);
                    if (migrateFile(task,target,id)) succeeded++;
                    else throw new ApiException(ErrorCode.CONFLICT);
                } catch (Exception ex) {
                    if (Thread.currentThread().isInterrupted()) throw ex;
                    failed++;
                    if (failures.size()<1000) {
                        var file=files.selectById(id);
                        failures.add(Map.of("fileId",id.toString(),"name",file==null?"":file.getOriginalName(),
                                "code",ex instanceof ApiException api?api.getCode().name():"STORAGE_UNAVAILABLE"));
                    }
                }
                processed++; after=id;
                String result=json.writeValueAsString(Map.of("processed",processed,"succeeded",succeeded,"failed",failed,
                        "failures",failures,"truncated",failed>failures.size()));
                if (mapper.migrationResult(task.getId(),worker,result,(int)Math.min(99,total==0?99:processed*100/total))!=1) return;
            }
            if (selected.isTextual()) break;
        }
        if (failed>0) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE,"Migration has failed files; see task result");
    }
    private boolean migrateFile(com.ufm.generated.entity.TasksEntity task,UUID target,UUID id) throws Exception {
        var snapshot=migrationPublication.snapshot(id); var file=snapshot.file();
        String key=file.getStorageKey(); List<MigrationPublication.Replacement> replacements=new ArrayList<>();
        List<String> staged=new ArrayList<>(); Path dir=Files.createTempDirectory("ufm-migration-");
        try {
            if (!target.equals(file.getStorageConfigId())) {
                key=task.getProjectId()+"/"+UUID.randomUUID();
                copyVerified(task,target,file.getStorageConfigId(),file.getStorageKey(),key,dir,staged);
            }
            for (var attachment:snapshot.attachments()) {
                if (target.equals(attachment.storage())) continue;
                requireMigrationOwner(task);
                String destination=task.getProjectId()+"/"+UUID.randomUUID(),metadata=attachment.metadata();
                if (attachment.kind().equals("HLS")) {
                    var node=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree(metadata);
                    String oldPrefix=node.path("prefix").asText(),prefix=task.getProjectId()+"/hls/"+UUID.randomUUID();
                    if (!node.path("assets").isArray() || node.path("assets").size()>100000)
                        throw new ApiException(ErrorCode.CONFLICT);
                    var names=new HashSet<String>();
                    for (var asset:node.path("assets")) {
                        String name=asset.asText();
                        if (!name.matches("(?:master|360|720)\\.m3u8|(?:360|720)-[0-9]{5}\\.ts") || !names.add(name))
                            throw new ApiException(ErrorCode.CONFLICT);
                        copyVerified(task,target,attachment.storage(),oldPrefix+"/"+name.replace('.','_'),prefix+"/"+name.replace('.','_'),dir,staged);
                    }
                    if (!names.contains("master.m3u8")) throw new ApiException(ErrorCode.CONFLICT);
                    destination=prefix+"/master_m3u8"; node.put("prefix",prefix); metadata=json.writeValueAsString(node);
                } else copyVerified(task,target,attachment.storage(),attachment.key(),destination,dir,staged);
                replacements.add(new MigrationPublication.Replacement(attachment,destination,metadata));
            }
            requireMigrationOwner(task);
            return migrationPublication.publish(snapshot,target,key,replacements,task.getId(),worker);
        } finally {
            // Durable deferred cleanup also covers process death and partially copied bundles.
            for (String stagedKey:staged) cleanup.scheduleMigration(task.getProjectId(),target,stagedKey,task.getId(),worker);
            Files.deleteIfExists(dir.resolve("object")); Files.deleteIfExists(dir.resolve("verified")); Files.deleteIfExists(dir);
        }
    }
    private void requireMigrationOwner(com.ufm.generated.entity.TasksEntity task) {
        var owned=mapper.selectById(task.getId());
        if (Thread.currentThread().isInterrupted() || owned==null || !"RUNNING".equals(owned.getStatus()) || !worker.equals(owned.getLockedBy()))
            throw new ApiException(ErrorCode.CONFLICT);
    }
    private void copyVerified(com.ufm.generated.entity.TasksEntity task,UUID target,UUID source,String sourceKey,String key,Path dir,List<String> staged) throws Exception {
        requireMigrationOwner(task);
        Path temp=dir.resolve("object"),verified=dir.resolve("verified");
        Files.deleteIfExists(temp); Files.deleteIfExists(verified);
        cleanup.scheduleMigration(task.getProjectId(),target,key,task.getId(),worker); staged.add(key);
        objects.get(source,sourceKey,temp); objects.put(target,key,temp); objects.get(target,key,verified);
        if (Files.size(temp)!=Files.size(verified) || !MessageDigest.isEqual(hash(temp),hash(verified))) throw new ApiException(ErrorCode.CONFLICT);
    }
    private byte[] hash(Path path) throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try (var in=Files.newInputStream(path)) { byte[] buffer=new byte[65536]; int n; while ((n=in.read(buffer))!=-1) digest.update(buffer,0,n); }
        return digest.digest();
    }
    @PreDestroy public void shutdown() { mapper.release(worker); }
}
