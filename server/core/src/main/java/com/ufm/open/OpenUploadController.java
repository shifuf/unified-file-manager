package com.ufm.open;

import com.ufm.common.error.*;
import com.ufm.file.*;
import jakarta.servlet.http.*;
import jakarta.validation.Valid;
import org.springframework.http.*;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/open")
@Transactional
public class OpenUploadController {
    private final UploadService uploads;
    private final DirectUploadService direct;
    public OpenUploadController(UploadService uploads,DirectUploadService direct) { this.uploads=uploads; this.direct=direct; }

    private UUID project() {
        Object principal=SecurityContextHolder.getContext().getAuthentication().getPrincipal();
        if (!(principal instanceof OpenApiAuthentication.Principal scoped)) throw new ApiException(ErrorCode.UNAUTHORIZED);
        return scoped.projectId();
    }
    private void scope(UUID project) { if (!project().equals(project)) throw new ApiException(ErrorCode.NOT_FOUND); }

    @PostMapping("/uploads/init") @ResponseStatus(HttpStatus.CREATED)
    public UploadService.State init(@Valid @RequestBody UploadService.Init input) { scope(input.projectId()); return uploads.init(input); }
    @GetMapping("/uploads/{id}")
    public UploadService.State state(@PathVariable UUID id) { uploads.requireProject(id,project()); return uploads.state(id); }
    @PutMapping(value="/uploads/{id}/chunks/{index}",consumes=MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public UploadService.State chunk(@PathVariable UUID id,@PathVariable int index,HttpServletRequest request) {
        uploads.requireProject(id,project());
        // Reuse the authenticated disk spool; servlet multipart parsing would bypass the signed body.
        HttpServletRequest current=request;
        while (!(current instanceof OpenApiAuthentication.AuthenticatedBody) && current instanceof HttpServletRequestWrapper wrapper)
            current=(HttpServletRequest)wrapper.getRequest();
        if (!(current instanceof OpenApiAuthentication.AuthenticatedBody body)) throw new ApiException(ErrorCode.UNAUTHORIZED);
        return uploads.chunk(id,index,new PathUpload(body.path(),"chunk"));
    }
    @PostMapping("/uploads/{id}/complete") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View complete(@PathVariable UUID id) { uploads.requireProject(id,project()); return uploads.complete(id); }
    @DeleteMapping("/uploads/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void abort(@PathVariable UUID id) { uploads.requireProject(id,project()); uploads.abort(id); }
    @PostMapping("/upload-credentials") @ResponseStatus(HttpStatus.CREATED)
    public Map<String,String> credential(@Valid @RequestBody UploadService.Credential input) { scope(input.projectId()); return uploads.credential(input); }
    @PostMapping("/uploads/presign") @ResponseStatus(HttpStatus.CREATED)
    public DirectUploadService.Presigned presign(@Valid @RequestBody DirectUploadService.Input input) { scope(input.projectId()); return direct.presign(input); }
    @PostMapping("/uploads/form") @ResponseStatus(HttpStatus.CREATED)
    public DirectUploadService.Form form(@Valid @RequestBody DirectUploadService.Input input) { scope(input.projectId()); return direct.form(input); }
    @PostMapping("/uploads/{id}/complete-form") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View completeForm(@PathVariable UUID id) { direct.requireFormProject(id,project()); return direct.completeForm(id); }
    @DeleteMapping("/uploads/{id}/form") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void abortForm(@PathVariable UUID id) { direct.requireFormProject(id,project()); direct.abortForm(id); }
    @PostMapping("/uploads/{id}/complete-presign") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View completePresign(@PathVariable UUID id) { direct.requireProject(id,project(),false); return direct.complete(id); }
    @PostMapping("/uploads/multipart-presign") @ResponseStatus(HttpStatus.CREATED)
    public DirectUploadService.Multipart multipart(@Valid @RequestBody DirectUploadService.Input input) { scope(input.projectId()); return direct.multipart(input); }
    @PostMapping("/uploads/{id}/parts/{part}/presign")
    public Map<String,String> part(@PathVariable UUID id,@PathVariable int part) { direct.requireProject(id,project(),true); return direct.part(id,part); }
    @PostMapping("/uploads/{id}/complete-multipart") @ResponseStatus(HttpStatus.CREATED)
    public FileDtos.View completeMultipart(@PathVariable UUID id,@Valid @RequestBody DirectUploadService.Parts input) {
        direct.requireProject(id,project(),true); return direct.completeMultipart(id,input);
    }
    @DeleteMapping("/uploads/{id}/multipart") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void abortMultipart(@PathVariable UUID id) { direct.requireProject(id,project(),true); direct.abortMultipart(id); }
}
