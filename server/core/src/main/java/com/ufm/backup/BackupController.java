package com.ufm.backup;

import org.springframework.http.*;
import org.springframework.core.io.FileSystemResource;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/backups")
public class BackupController {
    private final BackupService service;
    public BackupController(BackupService service) { this.service=service; }
    @io.swagger.v3.oas.annotations.media.Schema(name="BackupCreate")
    public record Create(boolean includeObjects) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="BackupRestore")
    public record Restore(String confirmation) {}
    @GetMapping public Map<String,Object> list() { return Map.of("items",service.list()); }
    @PostMapping @ResponseStatus(HttpStatus.CREATED) public BackupService.View create(@RequestBody Create input) { return service.create(input.includeObjects()); }
    @PostMapping(value="/import",consumes=MediaType.MULTIPART_FORM_DATA_VALUE) @ResponseStatus(HttpStatus.CREATED)
    public BackupService.View importBackup(@RequestPart org.springframework.web.multipart.MultipartFile file) throws Exception { return service.importBackup(file); }
    @DeleteMapping("/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void delete(@PathVariable UUID id) throws Exception { service.delete(id); }
    @GetMapping("/{id}") public BackupService.View get(@PathVariable UUID id) { return service.get(id); }
    @GetMapping("/{id}/download") public ResponseEntity<FileSystemResource> download(@PathVariable UUID id) { return service.download(id); }
    @PostMapping("/{id}/restore") @ResponseStatus(HttpStatus.ACCEPTED)
    public void restore(@PathVariable UUID id,@RequestBody Restore input) { service.restore(id,input.confirmation()); }
}
