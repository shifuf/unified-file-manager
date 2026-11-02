package com.ufm.project;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.UUID;

@RestController
@RequestMapping("/api/projects")
public class ProjectPackageController {
    private final ProjectPackageService packages;
    public ProjectPackageController(ProjectPackageService packages) { this.packages=packages; }

    @GetMapping("/{id}/export")
    public void export(@PathVariable UUID id,HttpServletResponse response) throws IOException {
        response.setStatus(HttpStatus.OK.value());
        response.setContentType("application/zip");
        response.setHeader(HttpHeaders.CONTENT_DISPOSITION,"attachment; filename=\"ufm-project-"+id+".zip\"");
        response.setHeader("X-Content-Type-Options","nosniff");
        packages.export(id,response.getOutputStream());
    }

    @PostMapping(path="/import",consumes=MediaType.MULTIPART_FORM_DATA_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    public ProjectPackageService.Imported importPackage(@RequestPart("file") MultipartFile file,
                                                        @RequestParam(required=false) UUID storageId) throws IOException {
        return packages.importPackage(file,storageId);
    }
}
