package com.ufm.share;

import com.ufm.common.config.UfmSecurityProperties;
import com.ufm.common.error.*;
import com.ufm.file.FileService;
import com.ufm.project.ProjectService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

@Service
public class DirectLinkService {
    private final FileService files;
    private final ProjectService projects;
    private final PublicDownloadService downloads;
    private final byte[] key;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.common.config.GlobalSettings global;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.storage.StorageService storage;
    public DirectLinkService(FileService files,ProjectService projects,PublicDownloadService downloads,UfmSecurityProperties config) {
        this.files=files; this.projects=projects; this.downloads=downloads; this.key=Base64.getDecoder().decode(config.getJwtSecret());
    }
    public Map<String,String> link(UUID id,int ttl,HttpServletRequest request) {
        var row=files.require(id,false);
        if (ttl<1 || ttl>604800) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        long exp=Instant.now().plusSeconds(ttl).getEpochSecond();
        String domain=global.get().downloadDomain();
        if (domain.isEmpty()) {
            Object custom=storage.config(row.getStorageConfigId()).get("customDomain");
            if (custom instanceof String value && !value.isBlank()) domain=value;
        }
        return Map.of("url",(domain.isEmpty()?"":global.origin(domain,false))+"/d/"+id+"?exp="+exp+"&sig="+signature(id,exp));
    }
    public ResponseEntity<?> download(UUID id,long exp,String sig,HttpServletRequest request) {
        if (exp<Instant.now().getEpochSecond() || exp>Instant.now().plusSeconds(604800).getEpochSecond()
                || sig==null || !MessageDigest.isEqual(signature(id,exp).getBytes(StandardCharsets.US_ASCII),sig.getBytes(StandardCharsets.US_ASCII)))
            throw new ApiException(ErrorCode.FORBIDDEN);
        var file=files.require(id,false); var project=projects.get(file.getProjectId());
        if (!project.allowedDomains().isEmpty()) {
            String origin=request.getHeader("Origin"); if (origin==null) origin=request.getHeader("Referer");
            String host=null;
            try { if (origin!=null) host=java.net.URI.create(origin).getHost(); } catch (IllegalArgumentException ignored) {}
            if (host==null || !project.allowedDomains().contains(host)) throw new ApiException(ErrorCode.FORBIDDEN);
        }
        return downloads.download(file,"PUBLIC",request);
    }
    private String signature(UUID id,long exp) {
        try {
            Mac mac=Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key,"HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(("/d/"+id+"\n"+exp).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException ex) { throw new IllegalStateException(ex); }
    }
}
