package com.ufm.dav;

import com.ufm.common.error.*;
import com.ufm.file.*;
import com.ufm.project.ProjectMapper;
import com.ufm.share.TransferAccounting;
import jakarta.servlet.http.*;
import jakarta.validation.Valid;
import org.springframework.http.*;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.core.io.FileSystemResource;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.net.URI;
import java.util.*;

@RestController
public class DavController {
    private final DavService dav;
    private final DavService.Queries queries;
    private final FileService files;
    private final ProjectMapper projects;
    private final TransferAccounting accounting;
    public DavController(DavService dav,DavService.Queries queries,FileService files,ProjectMapper projects,TransferAccounting accounting) { this.dav=dav; this.queries=queries; this.files=files; this.projects=projects; this.accounting=accounting; }
    @PutMapping("/api/webdav/{id}") public DavService.View save(@PathVariable UUID id,@Valid @RequestBody DavService.Input input) { return dav.save(id,input); }
    @GetMapping("/api/webdav/{id}") public DavService.View settings(@PathVariable UUID id) { return dav.get(id); }
    @RequestMapping("/dav/{project}/**")
    @Transactional
    public ResponseEntity<?> handle(@PathVariable UUID project,HttpServletRequest request) throws java.io.IOException {
        var auth=SecurityContextHolder.getContext().getAuthentication();
        if (!(auth.getPrincipal() instanceof DavService.Principal scoped) || !scoped.projectId().equals(project)) throw new ApiException(ErrorCode.UNAUTHORIZED);
        String prefix="/dav/"+project,path=path(request.getRequestURI(),prefix);
        String method=request.getMethod();
        if (method.equals("OPTIONS")) return ResponseEntity.ok().header("DAV","1, 2").header("MS-Author-Via","DAV").header("Allow","OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY, LOCK, UNLOCK").build();
        if (!Set.of("GET","HEAD","PROPFIND").contains(method)) {
            projects.lock(project);
            dav.checkLock(project,path,method.equals("UNLOCK")?request.getHeader("Lock-Token"):request.getHeader("If"));
        }
        if (method.equals("PROPFIND")) return propfind(project,path,prefix,request);
        if (method.equals("GET") || method.equals("HEAD")) return download(project,path,request);
        if (method.equals("MKCOL")) {
            if (exists(project,path)) throw new ApiException(ErrorCode.DUPLICATE_RESOURCE);
            files.folder(new FileDtos.FolderInput(project,FilePaths.folder(path))); return ResponseEntity.status(201).build();
        }
        if (method.equals("PUT")) {
            if (path.endsWith("/")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            boolean exists=exists(project,path); Path temp=Files.createTempFile("ufm-dav-",".body");
            try {
                try (var in=request.getInputStream(); var out=Files.newOutputStream(temp)) {
                    byte[] buffer=new byte[65536]; long size=0; int n;
                    while ((n=in.read(buffer))!=-1) { size+=n; if (size>com.ufm.common.config.UploadLimits.MAX_FILE_BYTES) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE); out.write(buffer,0,n); }
                }
                files.ingest(project,parent(path),new PathUpload(temp,name(path))); return ResponseEntity.status(exists?204:201).build();
            } finally { Files.deleteIfExists(temp); }
        }
        if (method.equals("DELETE")) {
            if (path.endsWith("/")) {
                if (path.equals("/")) throw new ApiException(ErrorCode.FORBIDDEN);
                List<UUID> batch; while (!(batch=queries.children(project,path)).isEmpty()) files.batchRecycle(new FileDtos.Batch(batch));
                queries.removeFolders(project,path);
            } else files.recycle(file(project,path));
            return ResponseEntity.noContent().build();
        }
        if (method.equals("MOVE") || method.equals("COPY")) {
            String target=destination(request,prefix); dav.checkLock(project,target,request.getHeader("If"));
            boolean existing=exists(project,target);
            if (existing && "F".equals(request.getHeader("Overwrite"))) return ResponseEntity.status(412).build();
            if (path.endsWith("/")) {
                target=FilePaths.folder(target);
                if (path.equals("/") || target.startsWith(path) || path.startsWith(target)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                if (existing) throw new ApiException(ErrorCode.DUPLICATE_RESOURCE);
                if (method.equals("MOVE")) files.moveFolder(new FileDtos.FolderMove(project,path,target));
                else {
                    String destination=target;
                    files.folder(new FileDtos.FolderInput(project,destination));
                    for (var folder:files.folders(project)) if (folder.path().startsWith(path))
                        files.folder(new FileDtos.FolderInput(project,destination+folder.path().substring(path.length())));
                    String depth=request.getHeader("Depth");
                    if (!"0".equals(depth)) {
                        for (int page=0;;page++) {
                            var batch=queries.copyBatch(project,path,(long)page*200);
                            for (UUID id:batch) {
                                var file=files.require(id,false);
                                files.copy(id,new FileDtos.Copy(destination+file.getFolderPath().substring(path.length()),file.getOriginalName()));
                            }
                            if (batch.size()<200) break;
                        }
                    }
                }
            } else if (method.equals("COPY")) files.copy(file(project,path),new FileDtos.Copy(parent(target),name(target)));
            else {
                if (path.equals(target)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                if (existing) files.recycle(file(project,target));
                files.edit(file(project,path),new FileDtos.Edit(name(target),parent(target),null,null,null));
            }
            return ResponseEntity.status(existing?204:201).build();
        }
        if (method.equals("LOCK")) {
            if (!exists(project,path)) throw new ApiException(ErrorCode.NOT_FOUND);
            int seconds=600; String timeout=request.getHeader("Timeout");
            if (timeout!=null && timeout.matches("Second-[0-9]{1,5}")) seconds=Math.max(60,Math.min(3600,Integer.parseInt(timeout.substring(7))));
            String token=dav.lock(project,path,request.getHeader("If"),seconds);
            return ResponseEntity.ok().header("Lock-Token","<"+token+">").contentType(MediaType.APPLICATION_XML)
                    .body("<?xml version=\"1.0\" encoding=\"utf-8\"?><D:prop xmlns:D=\"DAV:\"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:timeout>Second-"+seconds+"</D:timeout><D:locktoken><D:href>"+token+"</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>");
        }
        if (method.equals("UNLOCK")) { dav.unlock(project,path,request.getHeader("Lock-Token")); return ResponseEntity.noContent().build(); }
        throw new ApiException(ErrorCode.METHOD_NOT_ALLOWED);
    }
    private ResponseEntity<?> download(UUID project,String path,HttpServletRequest request) {
        var row=files.require(file(project,path),false); String range=request.getHeader("Range");
        if (range!=null) try { ByteRange.parse(range,row.getSize()); } catch (IllegalArgumentException ex) { return ResponseEntity.status(416).header("Content-Range","bytes */"+row.getSize()).build(); }
        String redirect=files.redirect(row);
        if (!request.getMethod().equals("HEAD")) accounting.start(row,"WEBDAV",redirect!=null,request);
        if (redirect!=null) return ResponseEntity.status(302).location(URI.create(redirect)).header("Cache-Control","no-store").build();
        return ResponseEntity.ok().header("Accept-Ranges","bytes").header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff")
                .contentType(MediaType.APPLICATION_OCTET_STREAM).body(new FileSystemResource(files.downloadPath(row)));
    }
    private ResponseEntity<String> propfind(UUID project,String path,String prefix,HttpServletRequest request) {
        String depth=Objects.toString(request.getHeader("Depth"),"1");
        if (!Set.of("0","1").contains(depth)) return ResponseEntity.status(403).contentType(MediaType.APPLICATION_XML).body("<D:error xmlns:D=\"DAV:\"><D:propfind-finite-depth/></D:error>");
        if (!exists(project,path)) throw new ApiException(ErrorCode.NOT_FOUND);
        StringBuilder xml=new StringBuilder("<?xml version=\"1.0\" encoding=\"utf-8\"?><D:multistatus xmlns:D=\"DAV:\">");
        append(xml,prefix,path,path.endsWith("/"),path.equals("/")?"/":name(path),path.endsWith("/")?0:files.require(file(project,path),false).getSize());
        if (path.endsWith("/") && depth.equals("1")) {
            for (var folder:files.folders(project)) if (!folder.path().equals(path) && parent(folder.path()).equals(path)) append(xml,prefix,folder.path(),true,name(folder.path()),0);
            for (int page=0;page<50;page++) {
                var batch=files.page(project,false,page,200,path,null,null,null);
                for (var file:batch.items()) append(xml,prefix,path+file.originalName(),false,file.originalName(),file.size());
                if ((long)(page+1)*200>=batch.total()) break;
            }
        }
        return ResponseEntity.status(207).contentType(MediaType.APPLICATION_XML).header("DAV","1, 2").body(xml.append("</D:multistatus>").toString());
    }
    private void append(StringBuilder xml,String prefix,String path,boolean folder,String name,long size) {
        String href; try { href=new URI(null,null,prefix+path,null).toASCIIString(); } catch (java.net.URISyntaxException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
        xml.append("<D:response><D:href>").append(escape(href)).append("</D:href><D:propstat><D:prop><D:displayname>").append(escape(name)).append("</D:displayname><D:resourcetype>").append(folder?"<D:collection/>":"").append("</D:resourcetype><D:getcontentlength>").append(size).append("</D:getcontentlength><D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>");
    }
    private String escape(String text) { return text.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;"); }
    private UUID file(UUID project,String path) { UUID id=queries.file(project,parent(path),name(path)); if (id==null) throw new ApiException(ErrorCode.FILE_NOT_FOUND); return id; }
    private boolean exists(UUID project,String path) {
        if (path.equals("/")) return true;
        return path.endsWith("/")?files.folders(project).stream().anyMatch(folder->folder.path().equals(path)):queries.file(project,parent(path),name(path))!=null;
    }
    private String parent(String path) { String trimmed=path.endsWith("/")?path.substring(0,path.length()-1):path; return trimmed.substring(0,trimmed.lastIndexOf('/')+1); }
    private String name(String path) { String trimmed=path.endsWith("/")?path.substring(0,path.length()-1):path; return FilePaths.name(trimmed.substring(trimmed.lastIndexOf('/')+1)); }
    private String path(String raw,String prefix) {
        if (!raw.startsWith(prefix+"/") || raw.matches("(?i).*%2[fF].*|.*%5[cC].*")) throw new ApiException(ErrorCode.FORBIDDEN);
        String decoded; try { decoded=java.net.URLDecoder.decode(raw.substring(prefix.length()).replace("+","%2B"),StandardCharsets.UTF_8); } catch (IllegalArgumentException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
        boolean folder=decoded.endsWith("/"); String normalized=FilePaths.folder(decoded); return folder?normalized:normalized.substring(0,normalized.length()-1);
    }
    private String destination(HttpServletRequest request,String prefix) {
        try {
            URI uri=URI.create(Objects.requireNonNull(request.getHeader("Destination")));
            if (uri.getQuery()!=null || uri.getFragment()!=null || uri.getUserInfo()!=null || (uri.isAbsolute() && (!Objects.equals(uri.getHost(),request.getServerName()) || !Objects.equals(uri.getScheme(),request.getScheme()) || (uri.getPort()<0?(uri.getScheme().equals("https")?443:80):uri.getPort())!=request.getServerPort()))) throw new IllegalArgumentException();
            return path(uri.getRawPath(),prefix);
        } catch (RuntimeException ex) { throw new ApiException(ErrorCode.FORBIDDEN); }
    }
}
