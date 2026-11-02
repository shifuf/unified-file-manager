package com.ufm.file;

import com.ufm.auth.RefreshTokenMapper;
import com.ufm.auth.jwt.JwtClaims;
import com.ufm.common.config.UfmSecurityProperties;
import com.ufm.common.crypto.SecretCipher;
import com.ufm.common.error.*;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.time.Instant;
import java.util.*;

@RestController
public class PreviewTicketController {
    private final FilePreviewService previews;
    private final RefreshTokenMapper sessions;
    private final SecretCipher cipher;
    private final UfmSecurityProperties config;
    public PreviewTicketController(FilePreviewService previews,RefreshTokenMapper sessions,SecretCipher cipher,UfmSecurityProperties config) {
        this.previews=previews; this.sessions=sessions; this.cipher=cipher; this.config=config;
    }
    @PostMapping("/api/files/{id}/preview-ticket")
    public ResponseEntity<Map<String,String>> ticket(@PathVariable UUID id,@AuthenticationPrincipal JwtClaims principal) {
        previews.get(id);
        String value=cipher.encrypt("preview:"+id+":"+principal.userId()+":"+principal.sessionId()+":"+Instant.now().plusSeconds(300).getEpochSecond());
        String path="/api/public/preview/"+id;
        return ResponseEntity.status(201).header("Cache-Control","no-store")
                .header("Set-Cookie",ResponseCookie.from("ufm_preview",value).httpOnly(true).secure(config.isCookieSecure())
                        .sameSite("Strict").path(path).maxAge(300).build().toString()).body(Map.of("url",path));
    }
    @GetMapping("/api/public/preview/{id}")
    public ResponseEntity<?> content(@PathVariable UUID id,@CookieValue(name="ufm_preview",required=false) String cookie,
                                    @RequestHeader(value="Range",required=false) String range) {
        authorize(id,cookie);
        return previews.content(id,range);
    }
    @GetMapping("/api/public/preview/{id}/hls/{asset}")
    public ResponseEntity<?> hls(@PathVariable UUID id,@PathVariable String asset,@CookieValue(name="ufm_preview",required=false) String cookie,
                                @RequestHeader(value="Range",required=false) String range) {
        authorize(id,cookie);
        return previews.hls(id,asset,range);
    }
    private void authorize(UUID id,String cookie) {
        try {
            String[] parts=cipher.decrypt(cookie).split(":");
            if (parts.length!=5 || !parts[0].equals("preview") || !parts[1].equals(id.toString())
                    || Long.parseLong(parts[4])<=Instant.now().getEpochSecond()
                    || !sessions.active(UUID.fromString(parts[3]),UUID.fromString(parts[2]))) throw new IllegalArgumentException();
        } catch (RuntimeException ex) { throw new ApiException(ErrorCode.UNAUTHORIZED); }
    }
}
