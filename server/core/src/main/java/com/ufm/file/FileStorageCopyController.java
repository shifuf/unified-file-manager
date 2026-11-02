package com.ufm.file;

import com.ufm.storage.StorageService;
import com.ufm.task.TaskService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
public class FileStorageCopyController {
    private final FileService files;
    private final StorageService storage;
    private final TaskService tasks;
    public FileStorageCopyController(FileService files,StorageService storage,TaskService tasks) { this.files=files; this.storage=storage; this.tasks=tasks; }
    @io.swagger.v3.oas.annotations.media.Schema(name="FileStorageCopy")
    public record Input(@NotNull UUID targetStorageId) {}
    @PostMapping("/api/files/{id}/copy-to-storage") @ResponseStatus(HttpStatus.ACCEPTED)
    public TaskService.View copy(@PathVariable UUID id,@Valid @RequestBody Input input) {
        var file=files.require(id,false); storage.requireEnabled(input.targetStorageId());
        return tasks.enqueue(file.getProjectId(),"STORAGE_MIGRATION",Map.of("targetStorageId",input.targetStorageId().toString(),"fileId",id.toString()));
    }
}
