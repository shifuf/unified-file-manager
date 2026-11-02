package com.ufm.backup;

import com.ufm.file.PathUpload;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.nio.file.Files;
import java.util.Map;

@RestController
@RequestMapping("/api/backups/remote")
public class RemoteBackupController {
    private final RemoteBackupService remote;
    private final BackupService backups;
    public RemoteBackupController(RemoteBackupService remote,BackupService backups) { this.remote=remote; this.backups=backups; }
    @GetMapping("/settings") public RemoteBackupService.View settings() { return remote.get(); }
    @PutMapping("/settings") public RemoteBackupService.View settings(@Valid @RequestBody RemoteBackupService.Input input) throws Exception { return remote.put(input); }
    @PostMapping("/test") public Map<String,Boolean> test() throws Exception { remote.test(); return Map.of("success",true); }
    @GetMapping("/files") public Map<String,Object> list() throws Exception { return Map.of("items",remote.list()); }
    @io.swagger.v3.oas.annotations.media.Schema(name="RemoteBackupImport")
    public record Import(@NotBlank @Size(max=128) String name) {}
    @PostMapping("/import") @ResponseStatus(HttpStatus.CREATED)
    public BackupService.View importBackup(@Valid @RequestBody Import input) throws Exception {
        var path=remote.fetch(input.name());
        try { return backups.importBackup(new PathUpload(path,input.name())); }
        finally { Files.deleteIfExists(path); }
    }
}
