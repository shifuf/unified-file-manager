package com.ufm.backup;

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
public class BackupDownloadTicketController {
    private final BackupService backups;
    private final RefreshTokenMapper sessions;
    private final SecretCipher cipher;
    private final UfmSecurityProperties config;
    public BackupDownloadTicketController(BackupService backups,RefreshTokenMapper sessions,SecretCipher cipher,UfmSecurityProperties config) {
        this.backups=backups; this.sessions=sessions; this.cipher=cipher; this.config=config;
    }
    @PostMapping("/api/backups/{id}/download-ticket")
    public ResponseEntity<Map<String,String>> ticket(@PathVariable UUID id,@AuthenticationPrincipal JwtClaims principal) {
        if (!backups.get(id).status().equals("DONE")) throw new ApiException(ErrorCode.CONFLICT);
        String value=cipher.encrypt(id+":"+principal.userId()+":"+principal.sessionId()+":"+Instant.now().plusSeconds(300).getEpochSecond());
        String path="/api/public/backup-download/"+id;
        return ResponseEntity.status(201).header("Cache-Control","no-store")
                .header("Set-Cookie",ResponseCookie.from("ufm_backup",value).httpOnly(true).secure(config.isCookieSecure())
                        .sameSite("Strict").path(path).maxAge(300).build().toString()).body(Map.of("url",path));
    }
    @GetMapping("/api/public/backup-download/{id}")
    public ResponseEntity<?> download(@PathVariable UUID id,@CookieValue(name="ufm_backup",required=false) String cookie) {
        try {
            String[] parts=cipher.decrypt(cookie).split(":");
            if (parts.length!=4 || !parts[0].equals(id.toString()) || Long.parseLong(parts[3])<=Instant.now().getEpochSecond()
                    || !sessions.active(UUID.fromString(parts[2]),UUID.fromString(parts[1]))) throw new IllegalArgumentException();
        } catch (RuntimeException ex) { throw new ApiException(ErrorCode.UNAUTHORIZED); }
        return backups.download(id);
    }
}
