package com.ufm.notify;

import com.ufm.auth.jwt.JwtClaims;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/notifications")
public class NotificationController {
    private final NotificationMapper mapper;
    public NotificationController(NotificationMapper mapper) { this.mapper=mapper; }
    @GetMapping public Map<String,Object> list(@AuthenticationPrincipal JwtClaims principal) { return Map.of("items",mapper.list(principal.userId())); }
    @GetMapping("/unread-count") public Map<String,Long> unread(@AuthenticationPrincipal JwtClaims principal) { return Map.of("count",mapper.unread(principal.userId())); }
    @PostMapping("/{id}/read") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void read(@AuthenticationPrincipal JwtClaims principal,@PathVariable UUID id) { mapper.read(principal.userId(),id); }
    @PostMapping("/read-all") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void readAll(@AuthenticationPrincipal JwtClaims principal) { mapper.readAll(principal.userId()); }
}
