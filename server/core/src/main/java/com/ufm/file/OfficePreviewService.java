package com.ufm.file;

import com.ufm.audit.AuditService;
import com.ufm.common.config.GlobalSettings;
import com.ufm.common.config.UfmSecurityProperties;
import com.ufm.common.error.*;
import com.ufm.storage.ObjectStore;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.InputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.*;

/**
 * 外部 Office 预览（KKFileView 兼容）安全闭环：
 * 管理员显式确认后才生成一次性取件票据，第三方服务用票据抓取一次原始字节；
 * 票据 120 秒过期、单次消费、只存摘要，审计记录实际外发与抓取。
 */
@Service
public class OfficePreviewService {
    private static final Set<String> OFFICE=Set.of(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    private static final SecureRandom RANDOM=new SecureRandom();
    private final FileService files;
    private final OfficePreviewMapper tickets;
    private final GlobalSettings global;
    private final ObjectStore objects;
    private final AuditService audit;
    private final UfmSecurityProperties security;
    private final String publicBaseUrl;

    public OfficePreviewService(FileService files,OfficePreviewMapper tickets,GlobalSettings global,ObjectStore objects,
                                AuditService audit,UfmSecurityProperties security,
                                @Value("${ufm.public-base-url:}") String publicBaseUrl) {
        this.files=files; this.tickets=tickets; this.global=global; this.objects=objects; this.audit=audit;
        this.security=security; this.publicBaseUrl=publicBaseUrl==null?"":publicBaseUrl.trim();
    }

    @io.swagger.v3.oas.annotations.media.Schema(name="OfficePreviewTicket")
    public record Ticket(String sourceUrl,String previewUrl,long expiresAt) {}

    @Transactional
    public Ticket create(UUID id,boolean confirmed,HttpServletRequest request) {
        var row=files.require(id,false);
        if (!OFFICE.contains(row.getMime()))
            throw new ApiException(ErrorCode.UNSUPPORTED_MEDIA_TYPE,"Office 在线预览仅支持 docx、xlsx、pptx");
        if (!confirmed)
            throw new ApiException(ErrorCode.INVALID_ARGUMENT,"外部预览会把该文件交给已配置的第三方服务，需管理员确认后重试");
        String service=global.get().officePreviewUrl();
        if (service==null || service.isBlank())
            throw new ApiException(ErrorCode.SERVICE_UNAVAILABLE,"Office 预览服务地址未配置，请在全局设置中填写");
        tickets.purge();
        byte[] raw=new byte[32]; RANDOM.nextBytes(raw);
        String token=Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        long expires=Instant.now().plusSeconds(120).getEpochSecond();
        tickets.insert(row.getId(),hash(token),Instant.ofEpochSecond(expires));
        String source=base(request)+"/api/public/office-preview/"+token;
        String encoded=Base64.getEncoder().encodeToString(source.getBytes(StandardCharsets.UTF_8));
        String preview=global.origin(service,true)+"/onlinePreview?url="+URLEncoder.encode(encoded,StandardCharsets.UTF_8);
        audit.record("office.preview.external",null,row.getProjectId(),ip(request),userAgent(request),
                detail(Map.of("fileId",row.getId().toString(),"service",service,"expiresAt",expires)));
        return new Ticket(source,preview,expires);
    }

    /** 第三方预览服务抓取入口：票据一次性，响应始终为附件下载，不允许内联执行。 */
    public ResponseEntity<?> fetch(String token,HttpServletRequest request) {
        if (token==null || !token.matches("[A-Za-z0-9_-]{20,64}")) throw new ApiException(ErrorCode.NOT_FOUND);
        String hash=hash(token);
        UUID fileId=tickets.file(hash);
        if (fileId==null || tickets.consume(hash)!=1) throw new ApiException(ErrorCode.NOT_FOUND);
        var row=files.require(fileId,false);
        long size=row.getSize()==null?objects.size(row.getStorageConfigId(),row.getStorageKey()):row.getSize();
        if (size<0) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        audit.record("office.preview.fetch",null,row.getProjectId(),ip(request),userAgent(request),
                detail(Map.of("fileId",row.getId().toString())));
        var response=ResponseEntity.status(200)
                .header("Cache-Control","private, no-store")
                .header("X-Content-Type-Options","nosniff")
                .header("X-Robots-Tag","noindex, nofollow")
                .header("Content-Security-Policy","default-src 'none'; sandbox")
                .header("Content-Disposition","attachment; filename=\"document."+extension(row.getMime())+"\"; filename*=UTF-8''"+URLEncoder.encode(row.getOriginalName(),StandardCharsets.UTF_8).replace("+","%20"))
                .contentType(MediaType.APPLICATION_OCTET_STREAM).contentLength(size);
        if (objects.local(row.getStorageConfigId())) return response.body(new FileSystemResource(objects.path(row.getStorageConfigId(),row.getStorageKey())));
        return response.body(new InputStreamResource((InputStream)objects.openRange(row.getStorageConfigId(),row.getStorageKey(),0,size),"Office preview source"));
    }

    private String base(HttpServletRequest request) {
        if (!publicBaseUrl.isEmpty()) return global.origin(publicBaseUrl,false);
        String scheme=request.getScheme(); String host=request.getServerName(); int port=request.getServerPort();
        if (security.isTrustProxy()) {
            String forwardedProto=request.getHeader("X-Forwarded-Proto"),forwardedHost=request.getHeader("X-Forwarded-Host");
            if (forwardedProto!=null && Set.of("http","https").contains(forwardedProto.toLowerCase(Locale.ROOT))) scheme=forwardedProto.toLowerCase(Locale.ROOT);
            if (forwardedHost!=null && forwardedHost.matches("[A-Za-z0-9.:\\[\\]-]{1,255}")) {
                host=forwardedHost; port=-1;
            }
        }
        if (host==null || !host.matches("[A-Za-z0-9.:\\[\\]-]{1,255}")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        boolean defaultPort=("http".equals(scheme)&&port==80)||("https".equals(scheme)&&port==443);
        return scheme+"://"+host+(port<0||defaultPort?"":":"+port);
    }
    private static String extension(String mime) {
        if (mime.endsWith("wordprocessingml.document")) return "docx";
        if (mime.endsWith("spreadsheetml.sheet")) return "xlsx";
        return "pptx";
    }
    private static String hash(String token) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
    private static String ip(HttpServletRequest request) {
        String value=request.getRemoteAddr();
        return value!=null && value.matches("[0-9a-fA-F:.]{2,64}")?value:null;
    }
    private static String userAgent(HttpServletRequest request) {
        String value=request.getHeader("User-Agent");
        return value==null?null:value.substring(0,Math.min(2048,value.length()));
    }
    private static String detail(Map<String,Object> values) {
        StringBuilder builder=new StringBuilder("{");
        values.forEach((key,value)->{
            if (builder.length()>1) builder.append(',');
            builder.append('"').append(key).append("\":\"").append(String.valueOf(value).replace("\\","\\\\").replace("\"","\\\"").replace("\n"," ")).append('"');
        });
        return builder.append('}').toString();
    }
}
