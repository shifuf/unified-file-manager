package com.ufm.share;

import com.ufm.common.config.UfmSecurityProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
public class ShareController {
    private final ShareService service;
    private final UfmSecurityProperties config;
    public ShareController(ShareService service,UfmSecurityProperties config) { this.service=service; this.config=config; }
    @PostMapping("/api/shares") @ResponseStatus(HttpStatus.CREATED)
    public ShareDtos.View create(@Valid @RequestBody ShareDtos.Input input) { return service.create(input,false); }
    @PostMapping("/api/folder-shares") @ResponseStatus(HttpStatus.CREATED)
    public ShareDtos.View createFolder(@Valid @RequestBody ShareDtos.Input input) { return service.create(input,true); }
    @GetMapping("/api/shares") public Map<String,Object> list() { return Map.of("items",service.list(false)); }
    @GetMapping("/api/folder-shares") public Map<String,Object> folders() { return Map.of("items",service.list(true)); }
    @PatchMapping("/api/shares/{id}") public ShareDtos.View edit(@PathVariable UUID id,@Valid @RequestBody ShareDtos.Edit input) { return service.edit(id,input,false); }
    @PatchMapping("/api/folder-shares/{id}") public ShareDtos.View editFolder(@PathVariable UUID id,@Valid @RequestBody ShareDtos.Edit input) { return service.edit(id,input,true); }
    @DeleteMapping("/api/shares/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void disable(@PathVariable UUID id) { service.disable(id,false); }
    @DeleteMapping("/api/folder-shares/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void disableFolder(@PathVariable UUID id) { service.disable(id,true); }
    @GetMapping("/s/{token}") public ShareDtos.PublicView file(@PathVariable String token,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return service.publicFile(token,cookie,request);
    }
    @PostMapping("/{kind:s|fs}/{token}/session")
    public ResponseEntity<Map<String,Boolean>> session(@PathVariable String kind,@PathVariable String token,
            @Valid @RequestBody ShareDtos.Password input,HttpServletRequest request) {
        String value=service.session(token,kind.equals("fs"),input.password(),request);
        return ResponseEntity.ok().header("Cache-Control","no-store").header("Set-Cookie",ResponseCookie.from("ufm_share",value)
                .httpOnly(true).secure(config.isCookieSecure()).sameSite("Strict").path("/"+kind+"/"+token).maxAge(600).build().toString())
                .body(Map.of("authenticated",true));
    }
    @GetMapping("/s/{token}/download") public ResponseEntity<?> download(@PathVariable String token,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return service.download(token,false,null,cookie,request);
    }
    @GetMapping("/fs/{token}/files") public Map<String,Object> folderFiles(@PathVariable String token,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return Map.of("items",service.folderFiles(token,cookie,request));
    }
    @GetMapping("/fs/{token}/browse") public ShareDtos.FolderPage browse(@PathVariable String token,@RequestParam(defaultValue="/") String path,
            @RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="50") int size,@RequestParam(defaultValue="name") String sort,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return service.browse(token,path,page,size,sort,cookie,request);
    }
    @GetMapping("/fs/{token}/download/{id}") public ResponseEntity<?> folderDownload(@PathVariable String token,@PathVariable UUID id,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return service.download(token,true,id,cookie,request);
    }
    @PostMapping("/api/library") @ResponseStatus(HttpStatus.OK)
    public void library(@Valid @RequestBody ShareDtos.Library input) { service.library(input); }
    @GetMapping("/s/{token}/preview") public ResponseEntity<com.ufm.file.FilePreviewService.Preview> preview(@PathVariable String token,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return ResponseEntity.ok().header("Cache-Control","private, no-store").body(service.preview(token,false,null,cookie,request));
    }
    @GetMapping("/fs/{token}/preview/{id}") public ResponseEntity<com.ufm.file.FilePreviewService.Preview> folderPreview(@PathVariable String token,@PathVariable UUID id,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return ResponseEntity.ok().header("Cache-Control","private, no-store").body(service.preview(token,true,id,cookie,request));
    }
    @GetMapping("/lib/{slug}/preview/{id}") public ResponseEntity<com.ufm.file.FilePreviewService.Preview> libraryPreview(@PathVariable String slug,@PathVariable UUID id,HttpServletRequest request) {
        return ResponseEntity.ok().header("Cache-Control","private, no-store").body(service.libraryPreview(slug,id,request));
    }
    @GetMapping("/s/{token}/preview-content") public ResponseEntity<?> previewContent(@PathVariable String token,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return service.previewContent(token,false,null,cookie,request);
    }
    @GetMapping("/fs/{token}/preview-content/{id}") public ResponseEntity<?> folderPreviewContent(@PathVariable String token,@PathVariable UUID id,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return service.previewContent(token,true,id,cookie,request);
    }
    @GetMapping("/lib/{slug}/preview-content/{id}") public ResponseEntity<?> libraryPreviewContent(@PathVariable String slug,@PathVariable UUID id,HttpServletRequest request) {
        return service.libraryPreviewContent(slug,id,request);
    }
    @GetMapping("/s/{token}/preview-hls/{asset}") public ResponseEntity<?> previewHls(@PathVariable String token,@PathVariable String asset,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return service.previewHls(token,false,null,asset,cookie,request);
    }
    @GetMapping("/fs/{token}/preview-hls/{id}/{asset}") public ResponseEntity<?> folderPreviewHls(@PathVariable String token,@PathVariable UUID id,@PathVariable String asset,
            @CookieValue(name="ufm_share",required=false) String cookie,HttpServletRequest request) {
        return service.previewHls(token,true,id,asset,cookie,request);
    }
    @GetMapping("/lib/{slug}/preview-hls/{id}/{asset}") public ResponseEntity<?> libraryPreviewHls(@PathVariable String slug,@PathVariable UUID id,@PathVariable String asset,HttpServletRequest request) {
        return service.libraryPreviewHls(slug,id,asset,request);
    }
    @GetMapping("/lib/{slug}") public ShareDtos.PublicPage library(@PathVariable String slug,@RequestParam(defaultValue="") String q,
            @RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="100") int size) { return service.libraryPage(slug,q,page,size); }
    @GetMapping("/lib/{slug}/download/{id}") public ResponseEntity<?> libraryDownload(@PathVariable String slug,@PathVariable UUID id,HttpServletRequest request) {
        return service.libraryDownload(slug,id,request);
    }
}
