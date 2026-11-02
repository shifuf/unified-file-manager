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
public class DownloadTicketController {
    private final FileController files;
    private final FileService service;
    private final RefreshTokenMapper sessions;
    private final SecretCipher cipher;
    private final UfmSecurityProperties config;
    public DownloadTicketController(FileController files,FileService service,RefreshTokenMapper sessions,SecretCipher cipher,UfmSecurityProperties config) {
        this.files=files; this.service=service; this.sessions=sessions; this.cipher=cipher; this.config=config;
    }
    @PostMapping("/api/files/{id}/download-ticket")
    public ResponseEntity<Map<String,String>> ticket(@PathVariable UUID id,@AuthenticationPrincipal JwtClaims principal) {
        service.require(id,false);
        String value=cipher.encrypt(id+":"+principal.userId()+":"+principal.sessionId()+":"+Instant.now().plusSeconds(300).getEpochSecond());
        String path="/api/public/download/"+id;
        return ResponseEntity.status(201).header("Cache-Control","no-store")
                .header("Set-Cookie",ResponseCookie.from("ufm_download",value).httpOnly(true).secure(config.isCookieSecure())
                        .sameSite("Strict").path(path).maxAge(300).build().toString())
                .body(Map.of("url",path));
    }
    @GetMapping("/api/public/download/{id}")
    public ResponseEntity<?> download(@PathVariable String id,@CookieValue(name="ufm_download",required=false) String cookie,
                                     @RequestHeader(value="Range",required=false) String range) {
        UUID file;
        try {
            String[] parts=cipher.decrypt(cookie).split(":"); file=UUID.fromString(id);
            if (parts.length!=4 || !parts[0].equals(id) || Long.parseLong(parts[3])<=Instant.now().getEpochSecond()
                    || !sessions.active(UUID.fromString(parts[2]),UUID.fromString(parts[1]))) throw new IllegalArgumentException();
        } catch (RuntimeException ex) { throw new ApiException(ErrorCode.UNAUTHORIZED); }
        return files.download(file,range);
    }
}
