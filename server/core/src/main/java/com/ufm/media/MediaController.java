package com.ufm.media;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.UUID;

@RestController
public class MediaController {
    private final MediaService service;
    public MediaController(MediaService service) { this.service=service; }
    @GetMapping("/api/files/{id}/thumbnail") public ResponseEntity<?> thumbnail(@PathVariable UUID id) { return service.thumbnail(id); }
    @GetMapping("/api/files/{id}/derivatives/{kind:THUMB|WEBP|COVER|MP4_720}")
    public ResponseEntity<?> derivative(@PathVariable UUID id,@PathVariable String kind) { return service.derivative(id,kind); }
    @GetMapping("/api/files/{id}/hls/{asset}")
    public ResponseEntity<?> hls(@PathVariable UUID id,@PathVariable String asset) { return service.hls(id,asset); }
}
