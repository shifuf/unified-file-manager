package com.ufm.file;

import org.springframework.web.bind.annotation.*;
import java.util.UUID;

@RestController
public class FileDetailsController {
    private final FileDetailsService service;
    public FileDetailsController(FileDetailsService service) { this.service=service; }
    @GetMapping("/api/files/{id}/details") public FileDetailsService.Details get(@PathVariable UUID id) { return service.get(id); }
}
