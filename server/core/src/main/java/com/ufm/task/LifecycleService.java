package com.ufm.task;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.error.*;
import com.ufm.file.*;
import com.ufm.notify.NotificationMapper;
import com.ufm.project.ProjectService;
import jakarta.validation.constraints.*;
import org.springframework.stereotype.Service;
import java.util.*;

@Service
public class LifecycleService {
    private final UploadMapper settings;
    private final LifecycleMapper mapper;
    private final ProjectService projects;
    private final FileService files;
    private final TaskService tasks;
    private final NotificationMapper notifications;
    private final ObjectMapper json;
    public LifecycleService(UploadMapper settings,LifecycleMapper mapper,ProjectService projects,FileService files,
                            TaskService tasks,NotificationMapper notifications,ObjectMapper json) {
        this.settings=settings; this.mapper=mapper; this.projects=projects; this.files=files; this.tasks=tasks;
        this.notifications=notifications; this.json=json;
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="LifecycleInput")
    public record Input(@NotNull UUID projectId,String folderPath,@Min(1) @Max(36500) int days,boolean enabled,
                        @Pattern(regexp="IMAGE|VIDEO|AUDIO|ARCHIVE|DOCUMENT|CODE|OTHER") String category) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="LifecyclePolicy")
    public record Policy(UUID id,UUID projectId,String folderPath,int days,boolean enabled,String category) {}
    public Policy create(Input input) {
        return save(UUID.randomUUID(),input);
    }
    public Policy update(UUID id,Input input) {
        var previous=require(id);
        if (!previous.projectId().equals(input.projectId())) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return save(id,input);
    }
    private Policy save(UUID id,Input input) {
        projects.require(input.projectId()); Policy policy=new Policy(id,input.projectId(),FilePaths.folder(input.folderPath()),input.days(),input.enabled(),input.category());
        try { settings.save("lifecycle."+policy.id(),json.writeValueAsString(policy)); return policy; }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public List<Policy> list() { return mapper.policies().stream().map(this::decode).toList(); }
    public void delete(UUID id) { settings.remove("lifecycle."+id); }
    public void run(UUID id) {
        Policy policy=require(id); if (!policy.enabled()) throw new ApiException(ErrorCode.CONFLICT);
        tasks.enqueue(policy.projectId(),"LIFECYCLE",Map.of("policyId",id.toString()));
    }
    public void execute(UUID id) {
        Policy policy=require(id); if (!policy.enabled()) throw new ApiException(ErrorCode.CONFLICT);
        int count=0;
        while (true) {
            var batch=mapper.expired(policy.projectId(),policy.folderPath(),policy.days(),policy.category()); if (batch.isEmpty()) break;
            for (UUID file:batch) { files.recycle(file); count++; }
        }
        if (Boolean.TRUE.equals(projects.require(policy.projectId()).getNotifyEnabled()))
            notifications.emit(policy.projectId(),"Lifecycle completed",count+" files moved to recycle bin","/recycle?project="+policy.projectId());
    }
    public void maintenance() { for (UUID id:mapper.purgeable()) files.purge(id); }
    private Policy require(UUID id) { String value=settings.manifest("lifecycle."+id); if (value==null) throw new ApiException(ErrorCode.NOT_FOUND); return decode(value); }
    private Policy decode(String value) { try { return json.readValue(value,Policy.class); } catch (java.io.IOException ex) { throw new IllegalStateException(ex); } }
}
