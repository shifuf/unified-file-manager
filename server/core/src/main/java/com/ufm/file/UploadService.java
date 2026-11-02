package com.ufm.file;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.auth.AuthService;
import com.ufm.common.error.*;
import com.ufm.project.ProjectService;
import jakarta.validation.constraints.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

@Service
public class UploadService {
    private final UploadMapper mapper;
    private final FileService files;
    private final ProjectService projects;
    private final ObjectMapper json;
    private final Path root;
    @org.springframework.beans.factory.annotation.Autowired private FileMapper fileMapper;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.common.config.GlobalSettings global;
    public UploadService(UploadMapper mapper,FileService files,ProjectService projects,ObjectMapper json,
                         @Value("${ufm.uploads.path:${java.io.tmpdir}/ufm-uploads}") String root) {
        this.mapper=mapper; this.files=files; this.projects=projects; this.json=json; this.root=Path.of(root).toAbsolutePath().normalize();
    }

    @io.swagger.v3.oas.annotations.media.Schema(name="UploadInit")
    public record Init(@NotNull UUID projectId,@NotBlank String originalName,String folderPath,
                       @Min(1) @Max(com.ufm.common.config.UploadLimits.MAX_FILE_BYTES) long size,
                       @Min(1) @Max(10485760) int chunkSize) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="UploadManifest")
    public record Manifest(UUID id,UUID projectId,String originalName,String folderPath,long size,int chunkSize,long expiresAt) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="UploadState")
    public record State(UUID id,long size,int chunkSize,List<Integer> uploaded) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="UploadCredential")
    public record Credential(@NotNull UUID projectId,String folderPath,@Min(1) long maxBytes,@Min(1) long maxFiles,
                             @Min(1) long maxFileBytes,@Size(max=50) List<String> allowedExtensions,
                             @Min(60) @Max(604800) int ttlSeconds) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="UploadScope")
    public record Scope(String folderPath,long maxFileBytes,List<String> allowedExtensions) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="UploadCredentialView")
    public record CredentialView(UUID id,long maxBytes,long usedBytes,long maxFiles,long usedFiles,
                                 java.time.OffsetDateTime expiresAt,java.time.OffsetDateTime revokedAt) {}
    public List<CredentialView> credentials(UUID project) { projects.require(project); return mapper.credentials(project); }
    public void preflight(DirectUploadService.Input input) {
        files.preflightDirect(input.projectId(),input.folderPath(),input.originalName(),input.size());
    }
    @Transactional
    public void revokeCredential(UUID id) {
        UUID project=mapper.credentialOwner(id); if (project==null) throw new ApiException(ErrorCode.NOT_FOUND);
        projects.require(project); mapper.revoke(id);
    }

    @Transactional
    public State init(Init input) {
        global.uploadSize(input.size());
        files.preflightDirect(input.projectId(),input.folderPath(),input.originalName(),input.size());
        if ((input.size()+input.chunkSize()-1)/input.chunkSize()>10000) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        UUID id=UUID.randomUUID();
        Manifest manifest=new Manifest(id,input.projectId(),FilePaths.name(input.originalName()),FilePaths.folder(input.folderPath()),
                input.size(),input.chunkSize(),Instant.now().plusSeconds(86400).getEpochSecond());
        mapper.save(key(id),encode(manifest));
        UUID task=UUID.randomUUID();
        fileMapper.cleanupTask(task,input.projectId(),encode(Map.of("chunkId",id.toString())));
        fileMapper.deferCleanup(task,86460);
        return new State(id,input.size(),input.chunkSize(),List.of());
    }

    @Transactional
    public State state(UUID id) { return state(require(id)); }

    @Transactional
    public void requireProject(UUID id,UUID project) {
        if (!require(id).projectId().equals(project)) throw new ApiException(ErrorCode.NOT_FOUND);
    }

    @Transactional
    public State chunk(UUID id,int index,MultipartFile chunk) {
        Manifest m=require(id); int count=(int)((m.size()+m.chunkSize()-1)/m.chunkSize());
        if (index<0 || index>=count) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        long expected=index==count-1?m.size()-(long)index*m.chunkSize():m.chunkSize();
        if (chunk.getSize()!=expected) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        Path dir=directory(id),temp=null;
        try {
            Files.createDirectories(dir); temp=Files.createTempFile(dir,"part-",".tmp");
            try (InputStream in=chunk.getInputStream(); OutputStream out=Files.newOutputStream(temp)) {
                long copied=in.transferTo(out); if (copied!=expected) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            }
            Files.move(temp,dir.resolve(Integer.toString(index)),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
            return state(m);
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        finally { if (temp!=null) try { Files.deleteIfExists(temp); } catch (IOException ignored) {} }
    }

    @Transactional
    public FileDtos.View complete(UUID id) {
        Manifest m=require(id); State state=state(m);
        int count=(int)((m.size()+m.chunkSize()-1)/m.chunkSize());
        if (state.uploaded().size()!=count) throw new ApiException(ErrorCode.CONFLICT);
        Path merged=directory(id).resolve("merged");
        try {
            try (OutputStream out=Files.newOutputStream(merged)) {
                for (int i=0;i<count;i++) try (InputStream in=Files.newInputStream(directory(id).resolve(Integer.toString(i)))) { in.transferTo(out); }
            }
            if (Files.size(merged)!=m.size()) throw new ApiException(ErrorCode.CONFLICT);
            FileDtos.View result=files.ingest(m.projectId(),m.folderPath(),new PathUpload(merged,m.originalName()));
            mapper.remove(key(id)); cleanup(id); return result;
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }

    @Transactional
    public void abort(UUID id) { require(id); mapper.remove(key(id)); cleanup(id); }

    @Transactional
    public void expire(UUID id) {
        mapper.lock(id.toString()); String value=mapper.manifest(key(id));
        if (value!=null && decode(value,Manifest.class).expiresAt()>=Instant.now().getEpochSecond())
            throw new ApiException(ErrorCode.CONFLICT);
        cleanup(id); mapper.remove(key(id));
    }

    @Transactional
    public Map<String,String> credential(Credential input) {
        projects.require(input.projectId()); String token=AuthService.randomSecret();
        List<String> extensions=input.allowedExtensions()==null?List.of():input.allowedExtensions().stream().map(v->v.toLowerCase(Locale.ROOT)).toList();
        mapper.credential(input.projectId(),AuthService.hash(token),encode(new Scope(FilePaths.folder(input.folderPath()),
                input.maxFileBytes(),extensions)),input.maxBytes(),input.maxFiles(),input.ttlSeconds());
        return Map.of("token",token);
    }

    @Transactional
    public FileDtos.View credentialUpload(String token,MultipartFile upload) {
        if (token==null || token.length()>128) throw new ApiException(ErrorCode.UNAUTHORIZED);
        String hash=AuthService.hash(token); String encoded=mapper.scope(hash);
        if (encoded==null) throw new ApiException(ErrorCode.UNAUTHORIZED);
        Scope scope=decode(encoded,Scope.class); String name=FilePaths.name(upload.getOriginalFilename());
        String ext=name.contains(".")?name.substring(name.lastIndexOf('.')+1).toLowerCase(Locale.ROOT):"";
        if (upload.getSize()>scope.maxFileBytes() || (!scope.allowedExtensions().isEmpty() && !scope.allowedExtensions().contains(ext)))
            throw new ApiException(ErrorCode.FORBIDDEN);
        if (mapper.consume(hash,upload.getSize())!=1) throw new ApiException(ErrorCode.QUOTA_EXHAUSTED);
        return files.ingest(mapper.project(hash),scope.folderPath(),upload);
    }

    private Manifest require(UUID id) {
        mapper.lock(id.toString()); String value=mapper.manifest(key(id));
        if (value==null) throw new ApiException(ErrorCode.NOT_FOUND);
        Manifest m=decode(value,Manifest.class);
        if (m.expiresAt()<Instant.now().getEpochSecond()) throw new ApiException(ErrorCode.TOKEN_EXPIRED);
        projects.require(m.projectId()); return m;
    }
    private State state(Manifest m) {
        List<Integer> uploaded=new ArrayList<>(); int count=(int)((m.size()+m.chunkSize()-1)/m.chunkSize());
        for (int i=0;i<count;i++) if (Files.isRegularFile(directory(m.id()).resolve(Integer.toString(i)),LinkOption.NOFOLLOW_LINKS)) uploaded.add(i);
        return new State(m.id(),m.size(),m.chunkSize(),uploaded);
    }
    private String key(UUID id) { return "upload."+id; }
    private Path directory(UUID id) {
        Path dir=root.resolve(id.toString()).normalize();
        if (!dir.startsWith(root)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        for (Path path=dir;path!=null;path=path.getParent()) if (Files.isSymbolicLink(path)) throw new ApiException(ErrorCode.FORBIDDEN);
        return dir;
    }
    private void cleanup(UUID id) {
        Path dir=directory(id);
        if (!Files.isDirectory(dir,LinkOption.NOFOLLOW_LINKS)) return;
        try (var paths=Files.list(dir)) {
            for (Path path:paths.toList()) Files.delete(path);
            Files.delete(dir);
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    private String encode(Object value) {
        try { return json.writeValueAsString(value); } catch (IOException ex) { throw new IllegalStateException(ex); }
    }
    private <T> T decode(String value,Class<T> type) {
        try { return json.readValue(value,type); } catch (IOException ex) { throw new IllegalStateException(ex); }
    }
}
