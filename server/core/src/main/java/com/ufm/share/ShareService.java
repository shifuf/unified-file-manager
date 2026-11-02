package com.ufm.share;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.auth.AuthService;
import com.ufm.common.crypto.SecretCipher;
import com.ufm.common.error.*;
import com.ufm.file.FileService;
import com.ufm.generated.entity.FilesEntity;
import com.ufm.project.ProjectService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.*;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.*;
import java.util.*;

@Service
public class ShareService {
    private final ShareMapper mapper;
    private final FileService files;
    private final PasswordEncoder passwords;
    private final SecretCipher cipher;
    private final ObjectMapper json;
    private final PublicDownloadService downloads;
    private final ProjectService projects;
    private final ShareRateLimiter rate;
    @org.springframework.beans.factory.annotation.Autowired private DownloadLedgerMapper ledger;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.file.FilePreviewService previews;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.common.config.GlobalSettings global;
    public ShareService(ShareMapper mapper,FileService files,PasswordEncoder passwords,SecretCipher cipher,ObjectMapper json,
                        PublicDownloadService downloads,ProjectService projects,ShareRateLimiter rate) {
        this.mapper=mapper; this.files=files; this.passwords=passwords; this.cipher=cipher; this.json=json;
        this.downloads=downloads; this.projects=projects; this.rate=rate;
    }
    @Transactional
    public ShareDtos.View create(ShareDtos.Input input,boolean folder) {
        IpPolicy.validate(input.allowedIps());
        if (folder) {
            if (input.folderId()==null || mapper.folderInfo(input.folderId())==null) throw new ApiException(ErrorCode.NOT_FOUND);
        } else { if (input.fileId()==null) throw new ApiException(ErrorCode.INVALID_ARGUMENT); files.require(input.fileId(),false); }
        UUID id=UUID.randomUUID(); String token=AuthService.randomSecret();
        String password=input.password()==null || input.password().isEmpty()?null:passwords.encode(input.password());
        String ips;
        try { ips=json.writeValueAsString(input.allowedIps()==null?List.of():input.allowedIps()); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        if (folder) mapper.createFolder(id,input.folderId(),token,password,ips,input);
        else mapper.createFile(id,input.fileId(),token,password,ips,input);
        return view(folder?mapper.folder(id):mapper.file(id));
    }
    public List<ShareDtos.View> list(boolean folder) { return (folder?mapper.folders():mapper.files()).stream().map(this::view).toList(); }
    public void disable(UUID id,boolean folder) { if (folder) mapper.disableFolder(id); else mapper.disableFile(id); }
    @Transactional
    public ShareDtos.View edit(UUID id,ShareDtos.Edit input,boolean folder) {
        ShareRow row=folder?mapper.folder(id):mapper.file(id);
        if (row==null || row.deletedAt()!=null) throw new ApiException(ErrorCode.NOT_FOUND);
        IpPolicy.validate(input.allowedIps());
        if (input.removePassword() && input.password()!=null && !input.password().isEmpty()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        String password=input.password()==null?null:passwords.encode(input.password());
        if (folder) mapper.editFolder(id,input,password); else mapper.editFile(id,input,password);
        String ips=null;
        try { if (input.allowedIps()!=null) ips=json.writeValueAsString(input.allowedIps()); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        if (folder) mapper.clearFolderPolicy(id,input,ips); else mapper.clearFilePolicy(id,input,ips);
        return view(folder?mapper.folder(id):mapper.file(id));
    }

    @Transactional(noRollbackFor=ApiException.class)
    public ShareDtos.PublicView publicFile(String token,String cookie,HttpServletRequest request) {
        ShareRow row=policy(token,false,request); password(row,cookie);
        var file=files.require(row.fileId(),false); ledger.access(file.getProjectId(),file.getId(),refererHost(request));
        return new ShareDtos.PublicView(publicView(file),row.previewOnly(),row.watermark());
    }
    @Transactional
    public String session(String token,boolean folder,String password,HttpServletRequest request) {
        ShareRow row=policy(token,folder,request);
        rate.password(row.id(),request.getRemoteAddr());
        if (row.passwordHash()!=null && !passwords.matches(password,row.passwordHash())) throw new ApiException(ErrorCode.INVALID_CREDENTIALS);
        return cipher.encrypt(row.id()+":"+Instant.now().plusSeconds(600).getEpochSecond()+":"+AuthService.hash(String.valueOf(row.passwordHash())));
    }
    @Transactional
    public List<ShareDtos.PublicFile> folderFiles(String token,String cookie,HttpServletRequest request) {
        ShareRow row=policy(token,true,request); password(row,cookie);
        var folder=mapper.folderInfo(row.folderId());
        if (folder==null) throw new ApiException(ErrorCode.NOT_FOUND);
        return mapper.folderFiles(folder.projectId(),folder.path()).stream().map(id->publicView(files.require(id,false))).toList();
    }
    @Transactional(noRollbackFor=ApiException.class)
    public ShareDtos.FolderPage browse(String token,String relative,int page,int size,String sort,String cookie,HttpServletRequest request) {
        if (page<0 || size<1 || size>200 || !List.of("name","size","recent").contains(sort)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        relative=com.ufm.file.FilePaths.folder(relative);
        var row=policy(token,true,request); password(row,cookie);
        var root=mapper.folderInfo(row.folderId()); if (root==null) throw new ApiException(ErrorCode.NOT_FOUND);
        global.publicRequest(request,projects.get(root.projectId()).allowedDomains());
        String path=root.path()+relative.substring(1),relativePath=relative;
        var children=mapper.childFolders(root.projectId(),path).stream().filter(name->!name.isBlank())
                .map(name->new ShareDtos.PublicFolder(name,relativePath+name+"/")).toList();
        var items=mapper.folderPage(root.projectId(),path,sort,size,(long)page*size).stream().map(id->publicView(files.require(id,false))).toList();
        return new ShareDtos.FolderPage(relative,children,items,mapper.folderCount(root.projectId(),path),page,size,row.previewOnly(),row.watermark());
    }
    @Transactional(noRollbackFor=ApiException.class)
    public ResponseEntity<?> download(String token,boolean folder,UUID fileId,String cookie,HttpServletRequest request) {
        ShareRow row=policy(token,folder,request); password(row,cookie);
        if (row.previewOnly()) throw new ApiException(ErrorCode.FORBIDDEN);
        FilesEntity file=files.require(folder?fileId:row.fileId(),false);
        if (folder) {
            var info=mapper.folderInfo(row.folderId());
            if (info==null || !file.getProjectId().equals(info.projectId()) || !file.getFolderPath().startsWith(info.path()))
                throw new ApiException(ErrorCode.FILE_NOT_FOUND);
        }
        ResponseEntity<?> response=downloads.download(file,folder?"FOLDER_SHARE":"SHARE",request);
        if (response.getStatusCode().is2xxSuccessful() || response.getStatusCode().is3xxRedirection()) {
            if (folder) mapper.countFolder(row.id()); else mapper.countFile(row.id());
        }
        return response;
    }
    @Transactional
    public void library(ShareDtos.Library input) { projects.require(input.projectId()); mapper.library(input.projectId(),input.enabled(),input.slug()); }
    public List<ShareDtos.PublicFile> library(String slug) {
        UUID project=mapper.libraryProject(slug); if (project==null) throw new ApiException(ErrorCode.NOT_FOUND);
        return mapper.publicFiles(project).stream().map(id->publicView(files.require(id,false))).toList();
    }
    public ShareDtos.PublicPage libraryPage(String slug,String query,int page,int size) {
        if (page<0 || size<1 || size>200 || query.length()>512) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        UUID project=mapper.libraryProject(slug); if (project==null) throw new ApiException(ErrorCode.NOT_FOUND);
        String terms=query.isBlank()?"":new com.ufm.file.search.SearchTextTokenizer().tokenize(query);
        return new ShareDtos.PublicPage(mapper.publicSearch(project,terms,size,(long)page*size).stream().map(id->publicView(files.require(id,false))).toList(),mapper.publicCount(project,terms),page,size);
    }
    @Transactional
    public ResponseEntity<?> libraryDownload(String slug,UUID id,HttpServletRequest request) {
        UUID project=mapper.libraryProject(slug); FilesEntity file=files.require(id,false);
        if (project==null || !file.getProjectId().equals(project) || !mapper.published(id)) throw new ApiException(ErrorCode.FILE_NOT_FOUND);
        return downloads.download(file,"PUBLIC",request);
    }
    private ShareRow policy(String token,boolean folder,HttpServletRequest request) {
        return policy(token,folder,request,false);
    }
    private ShareRow policy(String token,boolean folder,HttpServletRequest request,boolean media) {
        ShareRow row=folder?mapper.publicFolder(token):mapper.publicFile(token);
        if (row==null || row.deletedAt()!=null || !row.enabled()) throw new ApiException(ErrorCode.NOT_FOUND);
        if (media) rate.media(row.id(),request.getRemoteAddr()); else rate.visit(row.id(),request.getRemoteAddr());
        if (row.expiresAt()!=null && !row.expiresAt().isAfter(OffsetDateTime.now())) throw new ApiException(ErrorCode.SHARE_EXPIRED);
        if (row.maxDownloads()!=null && row.downloadCount()>=row.maxDownloads()) throw new ApiException(ErrorCode.FORBIDDEN);
        List<String> ips;
        try { ips=json.readValue(row.allowedIps(),new TypeReference<>(){}); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        if (!IpPolicy.allows(ips,request.getRemoteAddr())) throw new ApiException(ErrorCode.FORBIDDEN);
        downloads.checkBan(request.getRemoteAddr());
        if (!folder) downloads.check(request.getRemoteAddr(),row.fileId());
        return row;
    }
    private void password(ShareRow row,String cookie) {
        if (row.passwordHash()==null) return;
        try {
            String[] parts=cipher.decrypt(cookie).split(":");
            if (parts.length==3 && parts[0].equals(row.id().toString()) && Long.parseLong(parts[1])>Instant.now().getEpochSecond()
                    && parts[2].equals(AuthService.hash(String.valueOf(row.passwordHash())))) return;
        } catch (RuntimeException ignored) {}
        throw new ApiException(ErrorCode.SHARE_PASSWORD_REQUIRED);
    }
    private ShareDtos.View view(ShareRow row) {
        try { return new ShareDtos.View(row.id(),row.fileId(),row.folderId(),row.token(),row.customPath(),
                row.expiresAt(),row.maxDownloads(),row.downloadCount(),row.previewOnly(),row.enabled(),row.watermark(),row.passwordHash()!=null,
                json.readValue(row.allowedIps(),new TypeReference<List<String>>(){})); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public ShareDtos.PublicFile publicView(FilesEntity row) { return new ShareDtos.PublicFile(row.getId(),row.getOriginalName(),row.getMime(),row.getSize()); }
    @Transactional(noRollbackFor=ApiException.class)
    public com.ufm.file.FilePreviewService.Preview preview(String token,boolean folder,UUID id,String cookie,HttpServletRequest request) {
        return previews.get(previewFile(token,folder,id,cookie,request,false).getId());
    }
    private FilesEntity previewFile(String token,boolean folder,UUID id,String cookie,HttpServletRequest request,boolean media) {
        ShareRow row=policy(token,folder,request,media); password(row,cookie);
        var file=files.require(folder?id:row.fileId(),false);
        if (folder) {
            var info=mapper.folderInfo(row.folderId());
            if (info==null || !info.projectId().equals(file.getProjectId()) || !file.getFolderPath().startsWith(info.path()))
                throw new ApiException(ErrorCode.FILE_NOT_FOUND);
        }
        global.publicRequest(request,projects.get(file.getProjectId()).allowedDomains());
        return file;
    }
    public com.ufm.file.FilePreviewService.Preview libraryPreview(String slug,UUID id,HttpServletRequest request) {
        UUID project=mapper.libraryProject(slug); var file=files.require(id,false);
        if (project==null || !project.equals(file.getProjectId()) || !mapper.published(id)) throw new ApiException(ErrorCode.FILE_NOT_FOUND);
        downloads.check(request.getRemoteAddr(),id); global.publicRequest(request,projects.get(project).allowedDomains());
        return previews.get(id);
    }
    @Transactional(noRollbackFor=ApiException.class)
    public ResponseEntity<?> previewContent(String token,boolean folder,UUID id,String cookie,HttpServletRequest request) {
        preview(token,folder,id,cookie,request);
        UUID file=folder?id:mapper.publicFile(token).fileId();
        return previews.content(file,request.getHeader("Range"));
    }
    public ResponseEntity<?> libraryPreviewContent(String slug,UUID id,HttpServletRequest request) {
        libraryPreview(slug,id,request);
        return previews.content(id,request.getHeader("Range"));
    }
    @Transactional(noRollbackFor=ApiException.class)
    public ResponseEntity<?> previewHls(String token,boolean folder,UUID id,String asset,String cookie,HttpServletRequest request) {
        var file=previewFile(token,folder,id,cookie,request,true);
        return previews.hls(file.getId(),asset,request.getHeader("Range"));
    }
    public ResponseEntity<?> libraryPreviewHls(String slug,UUID id,String asset,HttpServletRequest request) {
        libraryPreview(slug,id,request);
        return previews.hls(id,asset,request.getHeader("Range"));
    }
    private String refererHost(HttpServletRequest request) {
        try {
            var uri=java.net.URI.create(request.getHeader("Referer")); String host=uri.getHost();
            return host==null || host.length()>255 || !("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))?"":host.toLowerCase(Locale.ROOT);
        } catch (RuntimeException ex) { return ""; }
    }
}
