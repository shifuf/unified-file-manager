package com.ufm.file;

import jakarta.validation.Valid;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.core.io.FileSystemResource;
import java.nio.charset.StandardCharsets;
import java.util.*;

@RestController
public class FileController {
    private final FileService service;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.share.TransferAccounting accounting;
    public FileController(FileService service) { this.service=service; }
    @PostMapping(value="/api/uploads/relay",consumes=MediaType.MULTIPART_FORM_DATA_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View upload(@RequestParam UUID projectId,@RequestParam(defaultValue="/") String folderPath,
                               @RequestPart MultipartFile file) { return service.ingest(projectId,folderPath,file); }
    @GetMapping("/api/files")
    public FileDtos.Page list(@RequestParam UUID projectId,@RequestParam(defaultValue="0") int page,
                             @RequestParam(defaultValue="100") int size,@RequestParam(required=false) String folderPath,
                             @RequestParam(required=false) String category,@RequestParam(required=false) String tag,
                             @RequestParam(required=false) String note) {
        return service.page(projectId,false,page,size,folderPath,category,tag,note);
    }
    @GetMapping("/api/files/search") public Map<String,Object> search(@RequestParam UUID projectId,@RequestParam String q) {
        return Map.of("items",service.search(projectId,q));
    }
    @GetMapping("/api/files/{id}") public FileDtos.View get(@PathVariable UUID id) { return service.get(id); }
    @PatchMapping("/api/files/{id}") public FileDtos.View edit(@PathVariable UUID id,@Valid @RequestBody FileDtos.Edit input) {
        return service.edit(id,input);
    }
    @DeleteMapping("/api/files/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) { service.recycle(id); }
    @PostMapping("/api/files/{id}/copy") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View copy(@PathVariable UUID id,@Valid @RequestBody FileDtos.Copy input) { return service.copy(id,input); }
    @GetMapping("/api/files/{id}/download")
    public ResponseEntity<?> download(@PathVariable UUID id,@RequestHeader(value="Range",required=false) String range) {
        var row=service.require(id,false);
        if (range!=null) try { ByteRange.parse(range,row.getSize()); }
        catch (IllegalArgumentException ex) { return ResponseEntity.status(416).header("Content-Range","bytes */"+row.getSize()).build(); }
        String redirect=service.redirect(row);
        var request=((org.springframework.web.context.request.ServletRequestAttributes)org.springframework.web.context.request.RequestContextHolder.currentRequestAttributes()).getRequest();
        accounting.start(row,"ADMIN",redirect!=null,request);
        if (redirect!=null) return ResponseEntity.status(HttpStatus.FOUND).header("Cache-Control","private, no-store").location(java.net.URI.create(redirect)).build();
        return ResponseEntity.ok().header("Accept-Ranges","bytes").header("X-Content-Type-Options","nosniff")
                .header(HttpHeaders.CACHE_CONTROL,"private, no-store")
                .header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(row.getOriginalName(),StandardCharsets.UTF_8).build().toString())
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(new FileSystemResource(service.downloadPath(row)));
    }
    @GetMapping("/api/recycle")
    public Map<String,Object> recycle(@RequestParam UUID projectId,@RequestParam(defaultValue="0") int page,
                                      @RequestParam(defaultValue="100") int size) {
        return Map.of("items",service.list(projectId,true,page,size));
    }
    @PostMapping("/api/recycle/{id}/restore") public FileDtos.View restore(@PathVariable UUID id) { return service.restore(id); }
    @DeleteMapping("/api/recycle/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void purge(@PathVariable UUID id) { service.purge(id); }
    @GetMapping("/api/versions") public Map<String,Object> versions(@RequestParam UUID fileId) { return Map.of("items",service.versions(fileId)); }
    @PostMapping("/api/versions/{id}/restore") public FileDtos.View version(@PathVariable UUID id) { return service.restoreVersion(id); }
    @GetMapping("/api/folders/tree") public Map<String,Object> tree(@RequestParam UUID projectId) { return Map.of("items",service.folders(projectId)); }
    @PostMapping("/api/folders") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.Folder folder(@Valid @RequestBody FileDtos.FolderInput input) { return service.folder(input); }
    @PostMapping("/api/folders/move") public Map<String,Object> moveFolder(@Valid @RequestBody FileDtos.FolderMove input) {
        return Map.of("items",service.moveFolder(input));
    }
    @PostMapping("/api/files/batch-recycle") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void batchRecycle(@Valid @RequestBody FileDtos.Batch input) { service.batchRecycle(input); }
    @PostMapping("/api/files/batch-move") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void batchMove(@Valid @RequestBody FileDtos.BatchMove input) { service.batchMove(input); }
    @PostMapping("/api/recycle/batch-restore") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void batchRestore(@Valid @RequestBody FileDtos.Batch input) { service.batchRestore(input); }
    @PostMapping("/api/recycle/batch-purge") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void batchPurge(@Valid @RequestBody FileDtos.Batch input) { service.batchPurge(input); }
}
