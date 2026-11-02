package com.ufm.file;

import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import java.util.UUID;

@RestController
public class FilePreviewController {
    private final FilePreviewService preview;
    public FilePreviewController(FilePreviewService preview) { this.preview=preview; }
    @GetMapping("/api/files/{id}/preview-content") public ResponseEntity<?> content(@PathVariable UUID id,
            @RequestHeader(value="Range",required=false) String range) { return preview.content(id,range); }
    @GetMapping("/api/files/{id}/preview") public ResponseEntity<FilePreviewService.Preview> get(@PathVariable UUID id) {
        return ResponseEntity.ok().header("Cache-Control","private, no-store").body(preview.get(id));
    }
}
