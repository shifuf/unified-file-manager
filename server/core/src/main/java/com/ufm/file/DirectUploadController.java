package com.ufm.file;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.UUID;

@RestController
@RequestMapping("/api/uploads")
public class DirectUploadController {
    private final DirectUploadService service;
    public DirectUploadController(DirectUploadService service) { this.service=service; }
    @PostMapping("/presign") @ResponseStatus(HttpStatus.CREATED)
    public DirectUploadService.Presigned presign(@Valid @RequestBody DirectUploadService.Input input) { return service.presign(input); }
    @PostMapping("/form") @ResponseStatus(HttpStatus.CREATED)
    public DirectUploadService.Form form(@Valid @RequestBody DirectUploadService.Input input) { return service.form(input); }
    @PostMapping("/{id}/complete-form") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View completeForm(@PathVariable UUID id) { return service.completeForm(id); }
    @DeleteMapping("/{id}/form") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void abortForm(@PathVariable UUID id) { service.abortForm(id); }
    @PostMapping("/{id}/complete-presign") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View complete(@PathVariable UUID id) { return service.complete(id); }
    @PostMapping("/multipart-presign") @ResponseStatus(HttpStatus.CREATED)
    public DirectUploadService.Multipart multipart(@Valid @RequestBody DirectUploadService.Input input) { return service.multipart(input); }
    @PostMapping("/{id}/parts/{part}/presign")
    public java.util.Map<String,String> part(@PathVariable UUID id,@PathVariable int part) { return service.part(id,part); }
    @PostMapping("/{id}/complete-multipart") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View completeMultipart(@PathVariable UUID id,@Valid @RequestBody DirectUploadService.Parts input) { return service.completeMultipart(id,input); }
    @DeleteMapping("/{id}/multipart") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void abort(@PathVariable UUID id) { service.abortMultipart(id); }
}
