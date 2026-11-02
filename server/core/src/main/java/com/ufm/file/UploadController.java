package com.ufm.file;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import java.util.*;

@RestController
public class UploadController {
    private final UploadService service;
    public UploadController(UploadService service) { this.service=service; }
    @PostMapping("/api/uploads/init") @ResponseStatus(HttpStatus.CREATED)
    public UploadService.State init(@Valid @RequestBody UploadService.Init input) { return service.init(input); }
    @GetMapping("/api/uploads/{id}") public UploadService.State state(@PathVariable UUID id) { return service.state(id); }
    @PostMapping("/api/uploads/{id}/chunk")
    public UploadService.State chunk(@PathVariable UUID id,@RequestParam int index,@RequestPart MultipartFile chunk) {
        return service.chunk(id,index,chunk);
    }
    @PostMapping("/api/uploads/{id}/complete") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View complete(@PathVariable UUID id) { return service.complete(id); }
    @DeleteMapping("/api/uploads/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void abort(@PathVariable UUID id) { service.abort(id); }
    @PostMapping("/api/upload-credentials") @ResponseStatus(HttpStatus.CREATED)
    public Map<String,String> credential(@Valid @RequestBody UploadService.Credential input) { return service.credential(input); }
    @GetMapping("/api/upload-credentials") public Map<String,Object> credentials(@RequestParam UUID projectId) { return Map.of("items",service.credentials(projectId)); }
    @DeleteMapping("/api/upload-credentials/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void revoke(@PathVariable UUID id) { service.revokeCredential(id); }
    @PostMapping("/api/public/uploads/credential") @ResponseStatus(HttpStatus.CREATED)
    public Receipt upload(@RequestHeader("X-Upload-Token") String token,@RequestPart MultipartFile file) {
        var uploaded=service.credentialUpload(token,file);
        return new Receipt(uploaded.originalName(),uploaded.size());
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="GuestUploadReceipt")
    public record Receipt(String originalName,long size) {}
}
