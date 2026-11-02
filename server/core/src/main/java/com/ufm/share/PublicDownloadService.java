package com.ufm.share;

import com.ufm.common.error.*;
import com.ufm.file.*;
import com.ufm.generated.entity.FilesEntity;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import java.nio.charset.StandardCharsets;

@Service
public class PublicDownloadService {
    private final FileService files;
    private final DownloadLedgerMapper ledger;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.notify.NotifyService notify;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.notify.FailureNotification failures;
    @org.springframework.beans.factory.annotation.Autowired private TransferAccounting accounting;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.common.config.GlobalSettings global;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.project.ProjectService projects;
    public PublicDownloadService(FileService files,DownloadLedgerMapper ledger) { this.files=files; this.ledger=ledger; }
    public void checkBan(String ip) { if (ledger.banned(ip)) throw new ApiException(ErrorCode.FORBIDDEN); }
    public void check(String ip,java.util.UUID file) {
        if (ledger.banned(ip)) throw new ApiException(ErrorCode.FORBIDDEN);
        if (ledger.recent(ip,file)>=60) {
            ledger.ipLimited(ip,file); failures.emit(files.require(file,false).getProjectId(),"RATE_LIMITED",java.util.Map.of("fileId",file.toString()));
            throw new ApiException(ErrorCode.RATE_LIMITED);
        }
    }
    public ResponseEntity<?> download(FilesEntity file,String source,HttpServletRequest request) {
        global.publicRequest(request,projects.get(file.getProjectId()).allowedDomains());
        check(request.getRemoteAddr(),file.getId());
        String range=request.getHeader("Range"); long bytes=file.getSize();
        if (range!=null) try { bytes=ByteRange.parse(range,file.getSize()).length(); }
        catch (IllegalArgumentException ex) { return ResponseEntity.status(416).header("Content-Range","bytes */"+file.getSize()).build(); }
        String redirect=files.redirect(file);
        if (redirect==null && !java.nio.file.Files.isRegularFile(files.downloadPath(file))) throw new ApiException(ErrorCode.FILE_NOT_FOUND);
        accounting.start(file,source,redirect!=null,request);
        ledger.ipDownload(request.getRemoteAddr(),file.getId());
        if (source.equals("SHARE") || source.equals("FOLDER_SHARE")) notify.event(file.getProjectId(),"SHARE_DOWNLOADED",java.util.Map.of("fileId",file.getId().toString(),"name",file.getOriginalName()));
        if (redirect!=null) return ResponseEntity.status(302).location(java.net.URI.create(redirect)).header("Cache-Control","private, no-store").build();
        return ResponseEntity.ok().header("Accept-Ranges","bytes").header("X-Content-Type-Options","nosniff")
                .header("Cache-Control","private, no-store").header("Content-Disposition",ContentDisposition.attachment()
                        .filename(file.getOriginalName(),StandardCharsets.UTF_8).build().toString())
                .contentType(MediaType.APPLICATION_OCTET_STREAM).body(new FileSystemResource(files.downloadPath(file)));
    }
    private String bounded(String value) { return value==null?null:value.substring(0,Math.min(2048,value.length())); }
}
