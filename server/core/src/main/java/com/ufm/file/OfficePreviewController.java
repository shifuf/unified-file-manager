package com.ufm.file;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.UUID;

@RestController
public class OfficePreviewController {
    private final OfficePreviewService previews;
    public OfficePreviewController(OfficePreviewService previews) { this.previews=previews; }

    @io.swagger.v3.oas.annotations.media.Schema(name="OfficePreviewRequest")
    public record Request(boolean confirmExternalTransfer) {}

    @PostMapping("/api/files/{id}/office-preview")
    public ResponseEntity<OfficePreviewService.Ticket> create(@PathVariable UUID id,
            @RequestBody(required=false) Request body,HttpServletRequest request) {
        return ResponseEntity.status(201).header("Cache-Control","no-store")
                .body(previews.create(id,body!=null && body.confirmExternalTransfer(),request));
    }

    @GetMapping("/api/public/office-preview/{token}")
    public ResponseEntity<?> fetch(@PathVariable String token,HttpServletRequest request) {
        return previews.fetch(token,request);
    }
}
