package com.ufm.task;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.error.*;
import com.ufm.generated.entity.TasksEntity;
import com.ufm.project.ProjectService;
import com.ufm.storage.StorageService;
import jakarta.validation.constraints.NotNull;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.OffsetDateTime;
import java.util.*;

@Service
public class TaskService {
    private final TaskMapper mapper;
    private final ProjectService projects;
    private final StorageService storage;
    private final ObjectMapper json;
    public TaskService(TaskMapper mapper,ProjectService projects,StorageService storage,ObjectMapper json) {
        this.mapper=mapper; this.projects=projects; this.storage=storage; this.json=json;
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="TaskMigration")
    public record Migration(@NotNull UUID projectId,@NotNull UUID targetStorageId) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="TaskView")
    public record View(UUID id,UUID projectId,String type,String status,int progress,int attempts,String error,OffsetDateTime createdAt,Map<String,Object> result) {}
    public View migration(Migration input) {
        projects.require(input.projectId()); storage.requireEnabled(input.targetStorageId());
        return enqueue(input.projectId(),"STORAGE_MIGRATION",Map.of("targetStorageId",input.targetStorageId().toString()));
    }
    public View enqueue(UUID project,String type,Object payload) {
        UUID id=UUID.randomUUID();
        try { mapper.enqueue(id,project,type,json.writeValueAsString(payload),null); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        return get(id);
    }
    public TasksEntity require(UUID id) {
        TasksEntity row=mapper.selectById(id);
        if (row==null || row.getDeletedAt()!=null) throw new ApiException(ErrorCode.NOT_FOUND);
        return row;
    }
    public View get(UUID id) { return view(require(id)); }
    public List<View> list() { return mapper.list().stream().map(this::view).toList(); }
    @Transactional
    public View action(UUID id,String action) {
        TasksEntity row=require(id); String expected=row.getStatus(); int changed;
        if (action.equals("retry")) changed=mapper.retry(id);
        else {
            String target=switch(action) {
                case "pause" -> (expected.equals("PENDING") || expected.equals("RUNNING"))?"PAUSED":null;
                case "resume" -> expected.equals("PAUSED")?"PENDING":null;
                case "cancel" -> List.of("PENDING","RUNNING","PAUSED").contains(expected)?"CANCELED":null;
                default -> null;
            };
            if (target==null) throw new ApiException(ErrorCode.CONFLICT);
            changed=mapper.transition(id,expected,target);
        }
        if (changed!=1) throw new ApiException(ErrorCode.CONFLICT);
        return get(id);
    }
    private View view(TasksEntity row) {
        Map<String,Object> result=Map.of();
        if (row.getResult()!=null) try { result=json.readValue(row.getResult(),new com.fasterxml.jackson.core.type.TypeReference<>(){}); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        return new View(row.getId(),row.getProjectId(),row.getType(),row.getStatus(),row.getProgress().intValue(),
                row.getAttempts().intValue(),row.getError(),row.getCreatedAt(),result);
    }
}
