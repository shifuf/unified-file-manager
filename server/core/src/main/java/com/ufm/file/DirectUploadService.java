package com.ufm.file;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.config.UploadLimits;
import com.ufm.common.error.*;
import com.ufm.project.ProjectService;
import com.ufm.storage.ObjectStore;
import jakarta.validation.constraints.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.Instant;
import java.util.UUID;
import java.util.*;

@Service
public class DirectUploadService {
    private final UploadMapper sessions;
    private final FileMapper mapper;
    private final FileService files;
    private final ObjectStore s3;
    private final ProjectService projects;
    private final ObjectMapper json;
    private final com.ufm.storage.StorageService storage;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.storage.StorageSelection selection;
    @org.springframework.beans.factory.annotation.Autowired private ObjectCleanup cleanup;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.common.config.GlobalSettings global;
    public DirectUploadService(UploadMapper sessions,FileMapper mapper,FileService files,ObjectStore s3,
                               ProjectService projects,ObjectMapper json,com.ufm.storage.StorageService storage) {
        this.sessions=sessions; this.mapper=mapper; this.files=files; this.s3=s3; this.projects=projects; this.json=json;
        this.storage=storage;
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="DirectUploadInput")
    public record Input(@NotNull UUID projectId,@NotBlank String originalName,String folderPath,
                        @Min(0) @Max(UploadLimits.MAX_FILE_BYTES) long size) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DirectUploadSession")
    public record Session(UUID id,UUID projectId,UUID storageId,String key,String originalName,String folderPath,long size,long expires) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DirectUploadFormSession")
    public record FormSession(Session session,String provider,String channel) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DirectUploadForm")
    public record Form(String channel,UUID id,String uploadUrl,int chunkSize,int partCount,Map<String,String> fields,long expiresIn) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DirectUploadPresigned")
    public record Presigned(UUID id,String method,String url,long expiresIn) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DirectUploadMultipartSession")
    public record MultipartSession(Session session,String uploadId) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DirectUploadMultipart")
    public record Multipart(UUID id,String method,int partSize,int partCount) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DirectUploadPart")
    public record Part(@Min(1) @Max(10000) int partNumber,@NotBlank @Size(max=200) String etag) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DirectUploadParts")
    public record Parts(@NotEmpty @Size(max=10000) List<@jakarta.validation.Valid Part> parts) {}
    @Transactional
    public void requireProject(UUID id,UUID project,boolean multipart) {
        sessions.lock(id.toString());
        String value=sessions.manifest((multipart?"multipart.":"direct.")+id);
        if (value==null) throw new ApiException(ErrorCode.NOT_FOUND);
        try {
            Session session=multipart?json.readValue(value,MultipartSession.class).session():decode(value);
            if (!session.projectId().equals(project)) throw new ApiException(ErrorCode.NOT_FOUND);
        } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    @Transactional
    public void requireFormProject(UUID id,UUID project) {
        sessions.lock(id.toString());
        String value=sessions.manifest("form."+id);
        if (value==null) throw new ApiException(ErrorCode.NOT_FOUND);
        if (!loadForm(value).session().projectId().equals(project)) throw new ApiException(ErrorCode.NOT_FOUND);
    }
    @Transactional
    public Presigned presign(Input input) {
        global.uploadSize(input.size());
        String folder=FilePaths.folder(input.folderPath()), name=FilePaths.name(input.originalName());
        files.preflightDirect(input.projectId(),folder,name,input.size());
        UUID storage=selection.active(input.projectId());
        if (storage==null) throw new ApiException(ErrorCode.STORAGE_NOT_FOUND);
        UUID id=UUID.randomUUID(); String key=input.projectId()+"/"+id;
        Session session=new Session(id,input.projectId(),storage,key,name,folder,input.size(),
                Instant.now().plusSeconds(900).getEpochSecond());
        String url=s3.putUrl(storage,key,input.size()); sessions.save("direct."+id,encode(session));
        scheduleStagingCleanup(session,960);
        return new Presigned(id,"PUT",url,900);
    }
    @Transactional
    public Form form(Input input) {
        global.uploadSize(input.size());
        String folder=FilePaths.folder(input.folderPath()), name=FilePaths.name(input.originalName());
        files.preflightDirect(input.projectId(),folder,name,input.size());
        UUID storage=selection.active(input.projectId());
        if (storage==null) throw new ApiException(ErrorCode.STORAGE_NOT_FOUND);
        String provider=this.storage.requireEnabled(storage).getProvider();
        if (input.size()>UploadLimits.FORM_DIRECT_MAX_BYTES || !(provider.equals("QINIU")||provider.equals("UPYUN")))
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        UUID id=UUID.randomUUID(); String key=input.projectId()+"/"+id;
        Session session=new Session(id,input.projectId(),storage,key,name,folder,input.size(),
                Instant.now().plusSeconds(900).getEpochSecond());
        FormSession formSession=new FormSession(session,provider,provider+"_FORM");
        sessions.save("form."+id,encode(formSession));
        // Register durable cleanup before returning upload credentials.
        scheduleFormCleanup(formSession,960);
        var form=s3.form(storage,key,input.size());
        return new Form(provider+"_FORM",id,form.uploadUrl(),UploadLimits.CHUNK_SIZE,1,form.fields(),form.expiresIn());
    }
    @Transactional
    public FileDtos.View complete(UUID id) {
        sessions.lock(id.toString()); String value=sessions.manifest("direct."+id);
        if (value==null) throw new ApiException(ErrorCode.NOT_FOUND);
        Session session=decode(value);
        if (session.expires()<Instant.now().getEpochSecond()) throw new ApiException(ErrorCode.TOKEN_EXPIRED);
        if (s3.size(session.storageId(),session.key())!=session.size()) throw new ApiException(ErrorCode.CONFLICT);
        String sealed=seal(session);
        FileDtos.View file=files.registerDirect(session.projectId(),session.folderPath(),session.originalName(),
                session.storageId(),sealed,session.size());
        sessions.remove("direct."+id); return file;
    }
    @Transactional
    public FileDtos.View completeForm(UUID id) {
        FormSession form=loadFormForUpdate(id);
        Session session=form.session();
        if (session.expires()<Instant.now().getEpochSecond()) throw new ApiException(ErrorCode.TOKEN_EXPIRED);
        if (s3.size(session.storageId(),session.key())!=session.size()) throw new ApiException(ErrorCode.CONFLICT);
        String sealed=copySeal(session);
        FileDtos.View file=files.registerDirect(session.projectId(),session.folderPath(),session.originalName(),
                session.storageId(),sealed,session.size());
        try {
            s3.remove(session.storageId(),session.key());
        } catch (ApiException ex) {
            // The durable form cleanup task remains the compensation path for staging removal.
        }
        sessions.remove("form."+id);
        return file;
    }
    @Transactional
    public void abortForm(UUID id) {
        FormSession form=loadFormForUpdate(id);
        s3.remove(form.session().storageId(),form.session().key());
        sessions.remove("form."+id);
    }
    @Transactional
    public Multipart multipart(Input input) {
        global.uploadSize(input.size());
        String folder=FilePaths.folder(input.folderPath()), name=FilePaths.name(input.originalName());
        files.preflightDirect(input.projectId(),folder,name,input.size());
        UUID storage=selection.active(input.projectId());
        if (storage==null) throw new ApiException(ErrorCode.STORAGE_NOT_FOUND);
        UUID id=UUID.randomUUID(); String key=input.projectId()+"/"+id;
        Session session=new Session(id,input.projectId(),storage,key,name,folder,input.size(),
                Instant.now().plusSeconds(86400).getEpochSecond());
        String upload=s3.multipart(storage,key);
        try { sessions.save("multipart."+id,json.writeValueAsString(new MultipartSession(session,upload))); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        scheduleStagingCleanup(session,86460);
        return new Multipart(id,"PUT",UploadLimits.CHUNK_SIZE,
                (int)Math.max(1,(input.size()+UploadLimits.CHUNK_SIZE-1)/UploadLimits.CHUNK_SIZE));
    }
    @Transactional
    public Map<String,String> part(UUID id,int part) {
        MultipartSession m=loadMultipart(id); Session s=m.session();
        int count=(int)Math.max(1,(s.size()+UploadLimits.CHUNK_SIZE-1)/UploadLimits.CHUNK_SIZE);
        if (part<1 || part>count) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return Map.of("url",s3.partUrl(s.storageId(),s.key(),m.uploadId(),part));
    }
    @Transactional
    public FileDtos.View completeMultipart(UUID id,Parts input) {
        MultipartSession m=loadMultipart(id); Session s=m.session();
        var ordered=input.parts().stream().sorted(Comparator.comparingInt(Part::partNumber)).toList();
        int count=(int)Math.max(1,(s.size()+UploadLimits.CHUNK_SIZE-1)/UploadLimits.CHUNK_SIZE);
        if (ordered.size()!=count) throw new ApiException(ErrorCode.CONFLICT);
        for (int i=0;i<count;i++) if (ordered.get(i).partNumber()!=i+1) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        s3.complete(s.storageId(),s.key(),m.uploadId(),ordered.stream().map(p->
                software.amazon.awssdk.services.s3.model.CompletedPart.builder().partNumber(p.partNumber()).eTag(p.etag()).build()).toList());
        if (s3.size(s.storageId(),s.key())!=s.size()) throw new ApiException(ErrorCode.CONFLICT);
        String sealed=seal(s);
        FileDtos.View file=files.registerDirect(s.projectId(),s.folderPath(),s.originalName(),s.storageId(),sealed,s.size());
        sessions.remove("multipart."+id); return file;
    }
    @Transactional
    public void abortMultipart(UUID id) {
        MultipartSession m=loadMultipart(id); s3.abort(m.session().storageId(),m.session().key(),m.uploadId()); sessions.remove("multipart."+id);
    }
    private MultipartSession loadMultipart(UUID id) {
        sessions.lock(id.toString()); String value=sessions.manifest("multipart."+id);
        if (value==null) throw new ApiException(ErrorCode.NOT_FOUND);
        try {
            MultipartSession m=json.readValue(value,MultipartSession.class);
            if (m.session().expires()<Instant.now().getEpochSecond()) throw new ApiException(ErrorCode.TOKEN_EXPIRED);
            return m;
        } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private FormSession loadFormForUpdate(UUID id) {
        sessions.lock(id.toString());
        String value=sessions.manifest("form."+id);
        if (value==null) throw new ApiException(ErrorCode.NOT_FOUND);
        return loadForm(value);
    }
    private String encode(Session session) {
        try { return json.writeValueAsString(session); } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private String encode(FormSession session) {
        try { return json.writeValueAsString(session); } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private FormSession loadForm(String value) {
        try { return json.readValue(value,FormSession.class); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private void scheduleStagingCleanup(Session session,int delay) {
        scheduleCleanup(session,delay>1000?"multipart.":"direct.",delay);
    }
    private void scheduleFormCleanup(FormSession form,int delay) {
        scheduleCleanup(form.session(),"form.",delay);
    }
    private void scheduleCleanup(Session session,String manifest,int delay) {
        UUID task=UUID.randomUUID();
        try {
            mapper.cleanupTask(task,session.projectId(),json.writeValueAsString(Map.of("objects",List.of(new FileMapper.ObjectRef(session.storageId(),session.key())),"manifest",manifest+session.id(),"sessionId",session.id())));
            mapper.deferCleanup(task,delay);
        } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private String seal(Session session) {
        String target=session.key()+"-sealed-"+UUID.randomUUID();
        // Commit compensation before external I/O so registration rollback cannot lose cleanup.
        cleanup.scheduleSealed(session.projectId(),session.storageId(),target);
        s3.seal(session.storageId(),session.key(),target,session.size());
        return target;
    }
    private String copySeal(Session session) {
        String target=session.key()+"-sealed-"+UUID.randomUUID();
        cleanup.scheduleSealed(session.projectId(),session.storageId(),target);
        s3.copy(session.storageId(),session.key(),target);
        return target;
    }
    private Session decode(String value) {
        try { return json.readValue(value,Session.class); } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
}
