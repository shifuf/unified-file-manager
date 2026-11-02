package com.ufm.file;

import com.ufm.common.error.*;
import com.ufm.common.id.UuidV7;
import com.ufm.file.search.SearchTextTokenizer;
import com.ufm.generated.entity.*;
import com.ufm.project.*;
import com.ufm.storage.ObjectStore;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;

@Service
public class FileService {
    private final FileMapper files;
    private final ProjectMapper projects;
    private final ProjectService projectService;
    private final ObjectStore objects;
    private final SearchTextTokenizer tokenizer=new SearchTextTokenizer();
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.notify.NotifyService notify;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.notify.FailureNotification failures;
    @org.springframework.beans.factory.annotation.Autowired private ObjectCleanup cleanup;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.storage.StorageSelection selection;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.common.config.GlobalSettings global;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.task.TaskMapper taskMapper;
    public FileService(FileMapper files,ProjectMapper projects,ProjectService projectService,ObjectStore objects) {
        this.files=files; this.projects=projects; this.projectService=projectService; this.objects=objects;
    }

    public FilesEntity require(UUID id,boolean recycled) {
        FilesEntity row=files.selectById(id);
        if (row==null || row.getDeletedAt()!=null || (!recycled && !row.getStatus().equals("ACTIVE")))
            throw new ApiException(ErrorCode.FILE_NOT_FOUND);
        projectService.require(row.getProjectId()); return row;
    }
    public FileDtos.View get(UUID id) { return view(require(id,false)); }
    public List<FileDtos.View> list(UUID project,boolean recycle,int page,int size) {
        projectService.require(project);
        if (page<0 || size<1 || size>200) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return files.list(project,recycle?"RECYCLED":"ACTIVE",size,Math.multiplyExact(page,size)).stream().map(this::view).toList();
    }
    public FileDtos.Page page(UUID project,boolean recycled,int page,int size,String folder,String category,String tag,String note) {
        projectService.require(project);
        if (page<0 || size<1 || size>200 || (category!=null && !List.of("IMAGE","VIDEO","AUDIO","ARCHIVE","DOCUMENT","CODE","OTHER").contains(category))
                || (tag!=null && tag.length()>64) || (note!=null && note.length()>4096)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        folder=folder==null?null:FilePaths.folder(folder); String status=recycled?"RECYCLED":"ACTIVE";
        var rows=files.filtered(project,status,folder,category,tag,note,size,(long)page*size);
        return new FileDtos.Page(rows.stream().map(this::view).toList(),files.filteredCount(project,status,folder,category,tag,note),page,size);
    }
    public List<FileDtos.View> search(UUID project,String query) {
        projectService.require(project);
        if (query.length()>512) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return files.search(project,tokenizer.tokenize(query)).stream().map(this::view).toList();
    }

    @Transactional
    public FileDtos.View ingest(UUID project,String folder,MultipartFile upload) {
        global.uploadSize(upload.getSize());
        long limit=Math.min(com.ufm.common.config.UploadLimits.MAX_FILE_BYTES,global.get().maxFileBytes());
        String name=FilePaths.name(upload.getOriginalFilename()); folder=FilePaths.folder(folder);
        Path temp=null;
        try {
            temp=Files.createTempFile("ufm-ingest-",".bin");
            MessageDigest digest=MessageDigest.getInstance("SHA-256"); long size=0;
            try (InputStream in=upload.getInputStream(); OutputStream out=Files.newOutputStream(temp)) {
                byte[] buffer=new byte[64*1024]; int read;
                while ((read=in.read(buffer))!=-1) {
                    size+=read; if (size>limit) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
                    digest.update(buffer,0,read); out.write(buffer,0,read);
                }
            }
            return ingestPath(project,folder,name,temp,size,HexFormat.of().formatHex(digest.digest()));
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        catch (NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
        finally { if (temp!=null) try { Files.deleteIfExists(temp); } catch (IOException ignored) {} }
    }

    private FileDtos.View ingestPath(UUID project,String folder,String name,Path source,long size,String checksum) throws IOException {
        ProjectsEntity p=projects.lock(project);
        if (p==null) throw new ApiException(ErrorCode.PROJECT_NOT_FOUND);
        FilesEntity previous=files.existing(project,folder,name);
        long delta=size-(previous==null?0:previous.getSize());
        checkQuota(p,delta,previous==null?1:0);
        UUID storage=selection.active(project);
        if (storage==null) throw new ApiException(ErrorCode.STORAGE_NOT_FOUND);
        UUID id=previous==null?UuidV7.generate():previous.getId();
        String key=project+"/"+UuidV7.generate();
        String mime=sniff(source,name);
        if (mime.equals("application/zip")) ArchiveSafety.check(source,10000,1024L*1024*1024);
        String ext=name.contains(".")?name.substring(name.lastIndexOf('.')+1).toLowerCase(Locale.ROOT):"";
        if (ext.length()>32) ext="";
        String content=mime.startsWith("text/")?readText(source):"";
        String search=tokenizer.tokenize(name+" "+content);
        FilesEntity duplicate=files.duplicate(project,checksum,size);
        boolean newObject=duplicate==null;
        if (duplicate!=null) { storage=duplicate.getStorageConfigId(); key=duplicate.getStorageKey(); }
        else objects.put(storage,key,source);
        try {
            if (previous==null) {
                FilesEntity row=new FilesEntity(); row.setId(id); row.setProjectId(project); row.setStorageConfigId(storage);
                row.setOriginalName(name); row.setStorageKey(key); row.setMime(mime); row.setExt(ext); row.setSize(size);
                row.setCategory(category(mime)); row.setStatus("ACTIVE"); row.setIsPublic(false); row.setChecksum(checksum);
                row.setContentText(content); row.setSearchText(search); row.setFolderPath(folder); row.setVersion(1);
                if (duplicate!=null) row.setDuplicateOf(duplicate.getId());
                files.insert(row);
            } else {
                invalidateDerivatives(previous);
                files.snapshot(id); files.replace(id,storage,key,mime,category(mime),ext,size,checksum,content,search);
            }
            files.folder(project,folder); files.quota(project,delta,previous==null?1:0);
            if (mime.startsWith("image/")) files.imageTask(project,id,previous==null?1:previous.getVersion()+1);
            if (mime.startsWith("video/")) files.videoTask(project,id,previous==null?1:previous.getVersion()+1);
            if (mime.startsWith("application/vnd.openxmlformats") || mime.equals("application/pdf")) files.searchTask(project,id,previous==null?1:previous.getVersion()+1);
            notify.event(project,"FILE_UPLOADED",Map.of("fileId",id.toString(),"name",name,"size",size));
            return get(id);
        } catch (RuntimeException ex) { if (newObject) objects.remove(storage,key); throw ex; }
    }

    @Transactional
    public void recycle(UUID id) { FilesEntity row=require(id,false); projects.lock(row.getProjectId()); files.status(id,"RECYCLED"); notify.event(row.getProjectId(),"FILE_DELETED",Map.of("fileId",id.toString(),"name",row.getOriginalName())); }
    @Transactional
    public FileDtos.View restore(UUID id) {
        FilesEntity row=require(id,true); projects.lock(row.getProjectId());
        if (!row.getStatus().equals("RECYCLED")) throw new ApiException(ErrorCode.CONFLICT);
        FilesEntity conflict=files.existing(row.getProjectId(),row.getFolderPath(),row.getOriginalName());
        if (conflict!=null) throw new ApiException(ErrorCode.DUPLICATE_RESOURCE);
        files.status(id,"ACTIVE"); return get(id);
    }
    @Transactional
    public void purge(UUID id) {
        FilesEntity row=require(id,true); projects.lock(row.getProjectId());
        if (!row.getStatus().equals("RECYCLED")) throw new ApiException(ErrorCode.CONFLICT);
        List<FileMapper.ObjectRef> candidates=new ArrayList<>(files.versionObjects(id));
        candidates.addAll(files.derivativeObjects(id));
        candidates.add(new FileMapper.ObjectRef(row.getStorageConfigId(),row.getStorageKey()));
        files.deleteVersions(id); files.deleteDerivatives(id); files.purge(id); files.quota(row.getProjectId(),-row.getSize(),-1);
        var unreferenced=candidates.stream().distinct().filter(o->!files.referenced(o.storageConfigId(),o.storageKey())).toList();
        UUID task=UUID.randomUUID();
        try { files.cleanupTask(task,row.getProjectId(),new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(Map.of("objects",unreferenced))); }
        catch (IOException ex) { throw new IllegalStateException(ex); }
        org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                new org.springframework.transaction.support.TransactionSynchronization() {
                    @Override public void afterCommit() {
                        try { cleanup.execute(task,row.getProjectId(),unreferenced); }
                        catch (RuntimeException ex) {
                            org.slf4j.LoggerFactory.getLogger(FileService.class).warn("Object cleanup deferred to durable task {}",task);
                        }
                    }
                });
    }
    public List<FileDtos.Version> versions(UUID id) { require(id,false); return files.versions(id); }
    @Transactional
    public FileDtos.View restoreVersion(UUID versionId) {
        FileVersionsEntity version=files.version(versionId);
        if (version==null || version.getDeletedAt()!=null) throw new ApiException(ErrorCode.NOT_FOUND);
        FilesEntity row=require(version.getFileId(),false); ProjectsEntity project=projects.lock(row.getProjectId());
        long delta=version.getSize()-row.getSize(); checkQuota(project,delta,0); invalidateDerivatives(row); files.snapshot(row.getId());
        files.replace(row.getId(),version.getStorageConfigId(),version.getStorageKey(),version.getMime(),category(version.getMime()),version.getExt(),
                version.getSize(),version.getChecksum(),"",tokenizer.tokenize(row.getOriginalName()));
        files.quota(row.getProjectId(),delta,0); return get(row.getId());
    }
    @Transactional
    public FileDtos.View edit(UUID id,FileDtos.Edit input) {
        FilesEntity row=require(id,false); projects.lock(row.getProjectId());
        String name=input.originalName()==null?row.getOriginalName():FilePaths.name(input.originalName());
        String folder=input.folderPath()==null?row.getFolderPath():FilePaths.folder(input.folderPath());
        FilesEntity collision=files.existing(row.getProjectId(),folder,name);
        if (collision!=null && !collision.getId().equals(id)) throw new ApiException(ErrorCode.DUPLICATE_RESOURCE);
        files.edit(id,name,folder,input.isPublic()==null?row.getIsPublic():input.isPublic()); files.folder(row.getProjectId(),folder);
        try {
            String tags=input.tags()==null?row.getTags():new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(input.tags());
            files.metadata(id,tags,input.note()==null?row.getNote():input.note());
        } catch (IOException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
        return get(id);
    }
    @Transactional
    public FileDtos.View copy(UUID id,FileDtos.Copy input) {
        FilesEntity row=require(id,false);
        if (objects.local(row.getStorageConfigId()))
            return ingest(row.getProjectId(),FilePaths.folder(input.folderPath()),new PathUpload(downloadPath(row),FilePaths.name(input.originalName())));
        Path temp=null;
        try {
            temp=Files.createTempFile("ufm-copy-",".bin"); Files.delete(temp);
            objects.get(row.getStorageConfigId(),row.getStorageKey(),temp);
            return ingest(row.getProjectId(),FilePaths.folder(input.folderPath()),new PathUpload(temp,FilePaths.name(input.originalName())));
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        finally { if (temp!=null) try { Files.deleteIfExists(temp); } catch (IOException ignored) {} }
    }
    @Transactional
    public FileDtos.Folder folder(FileDtos.FolderInput input) {
        projectService.require(input.projectId()); String path=FilePaths.folder(input.path());
        files.folder(input.projectId(),path);
        return files.folders(input.projectId()).stream().filter(f->f.path().equals(path)).findFirst().orElseThrow();
    }
    public List<FileDtos.Folder> folders(UUID project) { projectService.require(project); return files.folders(project); }
    @Transactional
    public List<FileDtos.Folder> moveFolder(FileDtos.FolderMove input) {
        if (projects.lock(input.projectId())==null) throw new ApiException(ErrorCode.PROJECT_NOT_FOUND);
        String source=FilePaths.folder(input.source()),target=FilePaths.folder(input.target());
        if (source.equals("/") || target.startsWith(source)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        boolean collision=files.folders(input.projectId()).stream().anyMatch(f->f.path().startsWith(target));
        if (collision) throw new ApiException(ErrorCode.DUPLICATE_RESOURCE);
        files.moveFiles(input.projectId(),source,target); files.moveFolders(input.projectId(),source,target);
        return folders(input.projectId());
    }
    @Transactional
    public void batchRecycle(FileDtos.Batch input) {
        List<FilesEntity> rows=input.ids().stream().distinct().map(id->require(id,false)).toList();
        rows.stream().map(FilesEntity::getProjectId).distinct().sorted().forEach(projects::lock);
        rows.forEach(row->files.status(row.getId(),"RECYCLED"));
    }
    @Transactional
    public void batchMove(FileDtos.BatchMove input) {
        String folder=FilePaths.folder(input.folderPath());
        var ids=input.ids().stream().distinct().toList();
        ids.stream().map(id->require(id,false).getProjectId()).distinct().sorted().forEach(projects::lock);
        ids.forEach(id->edit(id,new FileDtos.Edit(null,folder,null,null,null)));
    }
    @Transactional
    public void batchRestore(FileDtos.Batch input) {
        var ids=input.ids().stream().distinct().toList();
        ids.stream().map(id->require(id,true).getProjectId()).distinct().sorted().forEach(projects::lock);
        ids.forEach(this::restore);
    }
    @Transactional
    public void batchPurge(FileDtos.Batch input) {
        var ids=input.ids().stream().distinct().toList();
        ids.stream().map(id->require(id,true).getProjectId()).distinct().sorted().forEach(projects::lock);
        ids.forEach(this::purge);
    }
    public Path downloadPath(FilesEntity row) { return objects.path(row.getStorageConfigId(),row.getStorageKey()); }
    public String redirect(FilesEntity row) {
        return objects.local(row.getStorageConfigId())?null:objects.downloadUrl(row.getStorageConfigId(),row.getStorageKey());
    }
    @Transactional
    public boolean completeMigration(FilesEntity copied,UUID target,String key) {
        // Serialize with uploads/purge; the object copied before I/O may already be stale.
        projects.lock(copied.getProjectId());
        return files.migrate(copied.getId(),copied.getStorageConfigId(),copied.getStorageKey(),copied.getVersion(),target,key)==1;
    }
    @Transactional
    public boolean completeTaskMigration(FilesEntity copied,UUID target,String key,UUID task,String worker) {
        projects.lock(copied.getProjectId());
        // Keep the task fence locked through the file CAS so a concurrent pause cannot be acknowledged then bypassed.
        var owner=taskMapper.lock(task);
        if (owner==null || !owner.getStatus().equals("RUNNING") || !worker.equals(owner.getLockedBy())
                || !copied.getProjectId().equals(owner.getProjectId())) return false;
        return completeMigration(copied,target,key);
    }

    @Transactional
    public FileDtos.View registerDirect(UUID project,String folder,String name,UUID storage,String key,long size) {
        global.uploadSize(size);
        ProjectsEntity p=projects.lock(project);
        if (p==null) throw new ApiException(ErrorCode.PROJECT_NOT_FOUND);
        folder=FilePaths.folder(folder); name=FilePaths.name(name);
        FilesEntity old=files.existing(project,folder,name); long delta=size-(old==null?0:old.getSize());
        checkQuota(p,delta,old==null?1:0);
        UUID id=old==null?UuidV7.generate():old.getId();
        if (old!=null) { invalidateDerivatives(old); files.snapshot(id); files.replace(id,storage,key,"application/octet-stream","OTHER","",size,null,"",tokenizer.tokenize(name)); }
        else {
            FilesEntity row=new FilesEntity(); row.setId(id); row.setProjectId(project); row.setStorageConfigId(storage);
            row.setStorageKey(key); row.setOriginalName(name); row.setSize(size); row.setMime("application/octet-stream");
            row.setCategory("OTHER"); row.setStatus("ACTIVE"); row.setIsPublic(false); row.setFolderPath(folder);
            row.setVersion(1); row.setSearchText(tokenizer.tokenize(name)); files.insert(row);
        }
        files.quota(project,delta,old==null?1:0); files.folder(project,folder);
        files.inspectTask(project,id,old==null?1:old.getVersion()+1,key);
        notify.event(project,"FILE_UPLOADED",Map.of("fileId",id.toString(),"name",name,"size",size));
        return get(id);
    }
    @Transactional
    public void preflightDirect(UUID project,String folder,String name,long size) {
        ProjectsEntity p=projects.lock(project);
        if (p==null) throw new ApiException(ErrorCode.PROJECT_NOT_FOUND);
        folder=FilePaths.folder(folder); name=FilePaths.name(name);
        FilesEntity previous=files.existing(project,folder,name);
        checkQuota(p,size-(previous==null?0:previous.getSize()),previous==null?1:0);
    }
    @Transactional
    public void completeInspection(FilesEntity source,String mime,String checksum,String content) {
        projects.lock(source.getProjectId());
        if (files.inspected(source.getId(),source.getVersion(),source.getStorageKey(),mime,category(mime),checksum,content,
                tokenizer.tokenize(source.getOriginalName()+" "+content))==0) return;
        if (mime.startsWith("image/")) files.imageTask(source.getProjectId(),source.getId(),source.getVersion());
        if (mime.startsWith("video/")) files.videoTask(source.getProjectId(),source.getId(),source.getVersion());
    }
    @Transactional
    public void quarantine(FilesEntity source) {
        projects.lock(source.getProjectId()); files.quarantine(source.getId(),source.getVersion(),source.getStorageKey());
    }
    public FileDtos.View view(FilesEntity row) {
        return new FileDtos.View(row.getId(),row.getProjectId(),row.getOriginalName(),row.getMime(),row.getSize(),row.getCategory(),
                row.getStatus(),row.getIsPublic(),row.getChecksum(),row.getFolderPath(),row.getVersion(),row.getCreatedAt(),tags(row.getTags()),row.getNote());
    }
    private void invalidateDerivatives(FilesEntity file) {
        var refs=files.derivativeObjects(file.getId()); files.deleteDerivatives(file.getId());
        if (!refs.isEmpty()) try { files.cleanupTask(UUID.randomUUID(),file.getProjectId(),new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(Map.of("objects",refs))); }
        catch (IOException ex) { throw new IllegalStateException(ex); }
    }
    private List<String> tags(String encoded) {
        try { return new com.fasterxml.jackson.databind.ObjectMapper().readValue(encoded,new com.fasterxml.jackson.core.type.TypeReference<>(){}); }
        catch (IOException ex) { throw new IllegalStateException(ex); }
    }
    private void checkQuota(ProjectsEntity project,long bytes,long count) {
        if ((project.getQuotaBytes()>0 && project.getUsedBytes()+bytes>project.getQuotaBytes()) ||
                (project.getQuotaFiles()>0 && project.getUsedFiles()+count>project.getQuotaFiles())) {
            failures.emit(project.getId(),"QUOTA_EXHAUSTED",Map.of("message","Project quota exhausted"));
            throw new ApiException(ErrorCode.QUOTA_EXHAUSTED);
        }
    }
    private String readText(Path source) throws IOException {
        try (InputStream input=Files.newInputStream(source)) { return new String(input.readNBytes(512*1024),StandardCharsets.UTF_8); }
    }
    static String sniff(Path path,String name) throws IOException {
        byte[] head; try (InputStream in=Files.newInputStream(path)) { head=in.readNBytes(512); }
        if (head.length>=8 && head[0]==(byte)137 && head[1]==80 && head[2]==78 && head[3]==71) return "image/png";
        if (head.length>=3 && head[0]==(byte)255 && head[1]==(byte)216 && head[2]==(byte)255) return "image/jpeg";
        String magic=new String(head,StandardCharsets.ISO_8859_1);
        if (magic.startsWith("GIF87a") || magic.startsWith("GIF89a")) return "image/gif";
        if (head.length>=12 && magic.startsWith("RIFF")) {
            if (magic.substring(8,12).equals("WEBP")) return "image/webp";
            if (magic.substring(8,12).equals("WAVE")) return "audio/wav";
        }
        if (magic.startsWith("fLaC")) return "audio/flac";
        if (magic.startsWith("OggS")) return "audio/ogg";
        if (magic.startsWith("ID3") || (head.length>=2 && head[0]==(byte)0xff && (head[1]&0xe0)==0xe0)) return "audio/mpeg";
        if (head.length>=4 && new String(head,0,4,StandardCharsets.US_ASCII).equals("%PDF")) return "application/pdf";
        if (head.length>=4 && head[0]==80 && head[1]==75) {
            if (name.toLowerCase(Locale.ROOT).endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            if (name.toLowerCase(Locale.ROOT).endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            if (name.toLowerCase(Locale.ROOT).endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            return "application/zip";
        }
        if (head.length>=12 && new String(head,4,4,StandardCharsets.US_ASCII).equals("ftyp")) {
            String brand=magic.substring(8,12);
            if (brand.equals("avif") || brand.equals("avis")) return "image/avif";
            return brand.equals("M4A ")?"audio/mp4":"video/mp4";
        }
        if (head.length>=4 && head[0]==0x1a && head[1]==0x45 && head[2]==(byte)0xdf && head[3]==(byte)0xa3) return "video/webm";
        for (byte value:head) if (value==0) return "application/octet-stream";
        return "text/plain";
    }
    private String category(String mime) {
        if (mime.startsWith("image/")) return "IMAGE";
        if (mime.startsWith("video/")) return "VIDEO";
        if (mime.startsWith("audio/")) return "AUDIO";
        if (mime.equals("application/zip")) return "ARCHIVE";
        if (mime.startsWith("text/") || mime.equals("application/pdf") || mime.startsWith("application/vnd.openxmlformats")) return "DOCUMENT";
        return "OTHER";
    }
}
