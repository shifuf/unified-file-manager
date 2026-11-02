package com.ufm.open;

import com.ufm.common.error.*;
import com.ufm.file.*;
import com.ufm.project.ProjectService;
import com.ufm.share.TransferAccounting;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.*;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.core.io.FileSystemResource;
import java.nio.charset.StandardCharsets;
import java.util.*;

@RestController
@RequestMapping("/api/open")
public class OpenApiController {
    private final FileService files;
    private final ProjectService projects;
    private final TransferAccounting accounting;
    @org.springframework.beans.factory.annotation.Autowired private FileMapper fileMapper;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.share.ShareService shares;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.share.ShareMapper shareMapper;
    public OpenApiController(FileService files,ProjectService projects,TransferAccounting accounting) { this.files=files; this.projects=projects; this.accounting=accounting; }
    private UUID project() {
        Object principal=SecurityContextHolder.getContext().getAuthentication().getPrincipal();
        if (!(principal instanceof OpenApiAuthentication.Principal scoped)) throw new ApiException(ErrorCode.UNAUTHORIZED);
        projects.require(scoped.projectId()); return scoped.projectId();
    }
    private com.ufm.generated.entity.FilesEntity require(UUID id,boolean recycled) {
        var row=files.require(id,recycled); if (!row.getProjectId().equals(project())) throw new ApiException(ErrorCode.FILE_NOT_FOUND); return row;
    }
    @GetMapping("/quota") public com.ufm.project.ProjectDtos.View quota() { return projects.get(project()); }
    @GetMapping("/files") public FileDtos.Page list(@RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="100") int size,@RequestParam(required=false) String folderPath) {
        return files.page(project(),false,page,size,folderPath,null,null,null);
    }
    @GetMapping("/files/search") public Map<String,Object> search(@RequestParam String q) { return Map.of("items",files.search(project(),q)); }
    @GetMapping("/files/{id}") public FileDtos.View get(@PathVariable UUID id) { require(id,false); return files.get(id); }
    @PatchMapping("/files/{id}") public FileDtos.View edit(@PathVariable UUID id,@Valid @RequestBody FileDtos.Edit input) { require(id,false); return files.edit(id,input); }
    @DeleteMapping("/files/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void delete(@PathVariable UUID id) { require(id,false); files.recycle(id); }
    @PostMapping("/recycle/{id}/restore") public FileDtos.View restore(@PathVariable UUID id) { require(id,true); return files.restore(id); }
    @GetMapping("/recycle") public FileDtos.Page recycle(@RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="100") int size) {
        return files.page(project(),true,page,size,null,null,null,null);
    }
    @PostMapping("/files/{id}/copy") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View copy(@PathVariable UUID id,@Valid @RequestBody FileDtos.Copy input) { require(id,false); return files.copy(id,input); }
    @GetMapping("/files/{id}/versions") public Map<String,Object> versions(@PathVariable UUID id) { require(id,false); return Map.of("items",files.versions(id)); }
    @PostMapping("/versions/{id}/restore") public FileDtos.View restoreVersion(@PathVariable UUID id) {
        var version=fileMapper.version(id); if (version==null || version.getDeletedAt()!=null) throw new ApiException(ErrorCode.NOT_FOUND);
        require(version.getFileId(),false); return files.restoreVersion(id);
    }
    @PostMapping("/files/batch-recycle") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void batchRecycle(@Valid @RequestBody FileDtos.Batch input) { input.ids().forEach(id->require(id,false)); files.batchRecycle(input); }
    @PostMapping("/recycle/batch-restore") @ResponseStatus(HttpStatus.NO_CONTENT)
    @org.springframework.transaction.annotation.Transactional
    public void batchRestore(@Valid @RequestBody FileDtos.Batch input) { input.ids().forEach(id->require(id,true)); files.batchRestore(input); }
    @PostMapping("/recycle/batch-purge") @ResponseStatus(HttpStatus.NO_CONTENT)
    @org.springframework.transaction.annotation.Transactional
    public void batchPurge(@Valid @RequestBody FileDtos.Batch input) { input.ids().forEach(id->require(id,true)); files.batchPurge(input); }
    @io.swagger.v3.oas.annotations.media.Schema(name="OpenFolderInput")
    public record FolderInput(@jakarta.validation.constraints.NotBlank String path) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="OpenFolderMove")
    public record FolderMove(@jakarta.validation.constraints.NotBlank String source,@jakarta.validation.constraints.NotBlank String target) {}
    @GetMapping("/folders/tree") public Map<String,Object> tree() { return Map.of("items",files.folders(project())); }
    @PostMapping("/folders") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.Folder folder(@Valid @RequestBody FolderInput input) { return files.folder(new FileDtos.FolderInput(project(),input.path())); }
    @PostMapping("/folders/move") public Map<String,Object> move(@Valid @RequestBody FolderMove input) { return Map.of("items",files.moveFolder(new FileDtos.FolderMove(project(),input.source(),input.target()))); }
    @PostMapping("/shares") @ResponseStatus(HttpStatus.CREATED)
    public com.ufm.share.ShareDtos.View share(@Valid @RequestBody com.ufm.share.ShareDtos.Input input) { require(input.fileId(),false); return shares.create(input,false); }
    @PostMapping("/folder-shares") @ResponseStatus(HttpStatus.CREATED)
    public com.ufm.share.ShareDtos.View folderShare(@Valid @RequestBody com.ufm.share.ShareDtos.Input input) {
        folderScope(input.folderId()); return shares.create(input,true);
    }
    @PatchMapping("/shares/{id}") public com.ufm.share.ShareDtos.View editShare(@PathVariable UUID id,@Valid @RequestBody com.ufm.share.ShareDtos.Edit input) {
        shareScope(id,false); return shares.edit(id,input,false);
    }
    @PatchMapping("/folder-shares/{id}") public com.ufm.share.ShareDtos.View editFolderShare(@PathVariable UUID id,@Valid @RequestBody com.ufm.share.ShareDtos.Edit input) {
        shareScope(id,true); return shares.edit(id,input,true);
    }
    @DeleteMapping("/shares/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void disableShare(@PathVariable UUID id) { shareScope(id,false); shares.disable(id,false); }
    @DeleteMapping("/folder-shares/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void disableFolderShare(@PathVariable UUID id) { shareScope(id,true); shares.disable(id,true); }
    private void folderScope(UUID id) {
        var folder=id==null?null:shareMapper.folderInfo(id);
        if (folder==null || !folder.projectId().equals(project())) throw new ApiException(ErrorCode.NOT_FOUND);
    }
    private void shareScope(UUID id,boolean folder) {
        var row=folder?shareMapper.folder(id):shareMapper.file(id);
        if (row==null || row.deletedAt()!=null) throw new ApiException(ErrorCode.NOT_FOUND);
        if (folder) folderScope(row.folderId()); else require(row.fileId(),false);
    }
    @PostMapping(value="/uploads",consumes=MediaType.APPLICATION_OCTET_STREAM_VALUE) @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View upload(@RequestParam String name,@RequestParam(defaultValue="/") String folderPath,HttpServletRequest request) {
        HttpServletRequest current=request;
        while (!(current instanceof OpenApiAuthentication.AuthenticatedBody) && current instanceof jakarta.servlet.http.HttpServletRequestWrapper wrapper) current=(HttpServletRequest)wrapper.getRequest();
        if (!(current instanceof OpenApiAuthentication.AuthenticatedBody body)) throw new ApiException(ErrorCode.UNAUTHORIZED);
        return files.ingest(project(),folderPath,new PathUpload(body.path(),FilePaths.name(name)));
    }
    @GetMapping("/files/{id}/download") public ResponseEntity<?> download(@PathVariable UUID id,@RequestHeader(value="Range",required=false) String range,HttpServletRequest request) {
        var row=require(id,false);
        if (range!=null) try { ByteRange.parse(range,row.getSize()); }
        catch (IllegalArgumentException ex) { return ResponseEntity.status(416).header("Content-Range","bytes */"+row.getSize()).build(); }
        String redirect=files.redirect(row); accounting.start(row,"OPEN_API",redirect!=null,request);
        if (redirect!=null) return ResponseEntity.status(302).header("Cache-Control","private, no-store").location(java.net.URI.create(redirect)).build();
        return ResponseEntity.ok().header("Accept-Ranges","bytes").header("X-Content-Type-Options","nosniff").header("Cache-Control","private, no-store")
                .header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(row.getOriginalName(),StandardCharsets.UTF_8).build().toString())
                .contentType(MediaType.APPLICATION_OCTET_STREAM).body(new FileSystemResource(files.downloadPath(row)));
    }
}
