package com.ufm.project;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.error.*;
import com.ufm.file.FilePaths;
import com.ufm.file.FileService;
import com.ufm.file.PathUpload;
import com.ufm.storage.ObjectStore;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * Project export/import package (dev-features §1.1): a project is packaged as a ZIP with a
 * manifest of metadata plus the referenced object bytes, and can be imported as a brand new
 * project. Only metadata that is safe to move between instances is exported: never secrets,
 * storage credentials, share links or audit rows.
 */
@Service
public class ProjectPackageService {
    static final String FORMAT="ufm-project/v1";
    static final long MAX_PACKAGE_BYTES=20L*1024*1024*1024;
    static final long MAX_OBJECT_BYTES=20L*1024*1024*1024;
    static final long MAX_TOTAL_BYTES=100L*1024*1024*1024;
    static final long MAX_MANIFEST_BYTES=16L*1024*1024;
    static final int MAX_FILES=20000;
    static final int MAX_VERSIONS=500;

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final ObjectStore objects;
    private final FileService files;
    private final ProjectService projects;

    public ProjectPackageService(JdbcTemplate jdbc,ObjectMapper json,ObjectStore objects,FileService files,ProjectService projects) {
        this.jdbc=jdbc; this.json=json; this.objects=objects; this.files=files; this.projects=projects;
    }

    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectPackageInfo")
    public record Info(String name,String description,long quotaBytes,long quotaFiles,List<String> allowedDomains) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectPackageVersion")
    public record VersionEntry(int version,String objectName,long size,String checksum) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectPackageFile")
    public record FileEntry(String folderPath,String originalName,List<String> tags,String note,boolean isPublic,List<VersionEntry> versions) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectPackageManifest")
    public record Manifest(String format,String exportedAt,Info project,List<FileEntry> files) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectPackageImport")
    public record Imported(UUID projectId,String name,int files,int versions,long bytes) {}

    private record ObjectRef(String objectName,long size){}
    private record Written(UUID storage,String key){}

    /** Streams the project package directly to the response; nothing is buffered in memory. */
    public void export(UUID project,OutputStream out) throws IOException {
        Map<String,Object> row;
        try {
            row=jdbc.queryForMap("SELECT name,description,quota_bytes,quota_files,allowed_domains::text AS domains "
                    +"FROM projects WHERE id=? AND deleted_at IS NULL",project);
        } catch (EmptyResultDataAccessException ex) { throw new ApiException(ErrorCode.PROJECT_NOT_FOUND); }
        List<Map<String,Object>> rows=jdbc.queryForList("SELECT id,folder_path,original_name,tags::text AS tags,note,is_public,"
                +"version,size,checksum,storage_config_id,storage_key FROM files WHERE project_id=? AND status='ACTIVE' "
                +"AND deleted_at IS NULL ORDER BY folder_path,original_name,id",project);
        if (rows.size()>MAX_FILES) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
        List<FileEntry> entries=new ArrayList<>();
        LinkedHashMap<String,Map<String,Object>> objectRefs=new LinkedHashMap<>();
        for (var file:rows) {
            UUID id=(UUID)file.get("id");
            List<VersionEntry> versions=new ArrayList<>();
            for (var history:jdbc.queryForList("SELECT version,size,checksum,storage_config_id,storage_key FROM file_versions "
                    +"WHERE file_id=? AND deleted_at IS NULL ORDER BY version",id)) versions.add(version(history,objectRefs));
            versions.add(version(file,objectRefs));
            List<String> tags=strings((String)file.get("tags"));
            entries.add(new FileEntry((String)file.get("folder_path"),(String)file.get("original_name"),tags,
                    (String)file.get("note"),Boolean.TRUE.equals(file.get("is_public")),List.copyOf(versions)));
        }
        Manifest manifest=new Manifest(FORMAT,OffsetDateTime.now().toString(),
                new Info((String)row.get("name"),(String)row.get("description"),((Number)row.get("quota_bytes")).longValue(),
                        ((Number)row.get("quota_files")).longValue(),strings((String)row.get("domains"))),List.copyOf(entries));
        Path temp=Files.createTempFile("ufm-export-",".bin");
        try (ZipOutputStream zip=new ZipOutputStream(new BufferedOutputStream(out),StandardCharsets.UTF_8)) {
            zip.putNextEntry(new ZipEntry("manifest.json"));
            zip.write(json.writeValueAsBytes(manifest));
            zip.closeEntry();
            for (var object:objectRefs.values()) {
                zip.putNextEntry(new ZipEntry((String)object.get("name")));
                UUID storage=(UUID)object.get("storage");
                String key=(String)object.get("key");
                if (objects.local(storage)) {
                    try (InputStream in=Files.newInputStream(objects.path(storage,key))) { in.transferTo(zip); }
                } else {
                    objects.get(storage,key,temp);
                    try (InputStream in=Files.newInputStream(temp)) { in.transferTo(zip); }
                }
                zip.closeEntry();
            }
        } finally { Files.deleteIfExists(temp); }
    }

    private VersionEntry version(Map<String,Object> row,Map<String,Map<String,Object>> objectRefs) {
        Object raw=row.get("checksum");
        String checksum=raw==null?"":raw.toString();
        if (!checksum.matches("[0-9a-f]{64}")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        long size=((Number)row.get("size")).longValue();
        String name="objects/"+checksum;
        var existing=objectRefs.get(name);
        if (existing!=null) {
            if (((Number)existing.get("size")).longValue()!=size) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        } else {
            Map<String,Object> ref=new HashMap<>();
            ref.put("name",name); ref.put("size",size);
            ref.put("storage",row.get("storage_config_id")); ref.put("key",row.get("storage_key"));
            objectRefs.put(name,ref);
        }
        return new VersionEntry(((Number)row.get("version")).intValue(),name,size,checksum);
    }

    private List<String> strings(String raw) {
        if (raw==null || raw.isBlank()) return List.of();
        try { return json.readValue(raw,new com.fasterxml.jackson.core.type.TypeReference<List<String>>(){}); }
        catch (IOException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }

    /**
     * Imports a package into a brand new project. Everything runs in one transaction so an
     * invalid or tampered package never leaves a half-imported project behind; the caller must
     * still treat orphaned objects after a rollback as a manual cleanup risk (documented).
     */
    @Transactional
    public Imported importPackage(MultipartFile upload,UUID storage) throws IOException {
        if (upload==null || upload.isEmpty()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        Path work=Files.createTempDirectory("ufm-project-import-");
        try {
            Path archive=work.resolve("package.zip");
            long[] total={0};
            try (InputStream in=upload.getInputStream(); OutputStream out=Files.newOutputStream(archive)) {
                copyBounded(in,out,MAX_PACKAGE_BYTES,total);
            }
            Manifest manifest=null;
            Map<String,Long> extracted=new LinkedHashMap<>();
            Path objectDir=Files.createDirectories(work.resolve("objects"));
            long[] extractedTotal={0};
            try (ZipInputStream zip=new ZipInputStream(Files.newInputStream(archive),StandardCharsets.UTF_8)) {
                for (ZipEntry entry;(entry=zip.getNextEntry())!=null;) {
                    String name=entry.getName();
                    if (entry.isDirectory()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                    if (name.equals("manifest.json")) {
                        if (manifest!=null) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                        manifest=json.readValue(readBounded(zip,MAX_MANIFEST_BYTES),Manifest.class);
                    } else if (name.startsWith("objects/")) {
                        String checksum=name.substring("objects/".length());
                        if (!checksum.matches("[0-9a-f]{64}") || extracted.containsKey(checksum))
                            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                        Path target=objectDir.resolve(checksum);
                        MessageDigest digest=sha256();
                        long[] written={0};
                        try (OutputStream out=Files.newOutputStream(target,StandardOpenOption.CREATE_NEW)) {
                            byte[] buffer=new byte[65536]; int read;
                            while ((read=zip.read(buffer))!=-1) {
                                written[0]+=read; extractedTotal[0]+=read;
                                if (written[0]>MAX_OBJECT_BYTES || extractedTotal[0]>MAX_TOTAL_BYTES)
                                    throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
                                digest.update(buffer,0,read); out.write(buffer,0,read);
                            }
                        }
                        if (!HexFormat.of().formatHex(digest.digest()).equals(checksum))
                            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                        extracted.put(checksum,written[0]);
                    } else throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                    zip.closeEntry();
                }
            }
            if (manifest==null) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            List<Written> written=new ArrayList<>();
            try {
                return register(manifest,extracted,objectDir,storage,written);
            } catch (RuntimeException failure) {
                // 事务回滚后数据库行会消失，但已写入存储的对象不会；逐个删除，避免留下无引用孤儿。
                for (Written ref:written) {
                    try { objects.remove(ref.storage(),ref.key()); }
                    catch (RuntimeException ignored) { /* 清理尽力而为，失败不掩盖原始错误 */ }
                }
                throw failure;
            }
        } finally { deleteTree(work); }
    }

    private Imported register(Manifest manifest,Map<String,Long> extracted,Path objectDir,UUID storage,List<Written> written) {
        if (!FORMAT.equals(manifest.format()) || manifest.project()==null || manifest.files()==null)
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        if (manifest.files().size()>MAX_FILES) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
        UUID target=storage!=null?storage:defaultStorage();
        if (target==null) throw new ApiException(ErrorCode.STORAGE_NOT_FOUND);
        long bytes=0;
        List<FileEntry> entries=new ArrayList<>();
        Set<String> used=new HashSet<>();
        for (FileEntry entry:manifest.files()) {
            if (entry==null || entry.versions()==null || entry.versions().isEmpty() || entry.versions().size()>MAX_VERSIONS)
                throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            String folder=FilePaths.folder(entry.folderPath());
            String name=FilePaths.name(entry.originalName());
            if (!used.add(folder+"\u0000"+name)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            int previous=0;
            for (VersionEntry version:entry.versions()) {
                if (version==null || version.version()<=previous || version.size()<0
                        || !("objects/"+version.checksum()).equals(version.objectName())
                        || !version.checksum().matches("[0-9a-f]{64}")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                Long size=extracted.get(version.checksum());
                if (size==null || size!=version.size()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                previous=version.version(); bytes+=version.size();
                if (bytes>MAX_TOTAL_BYTES) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
            }
            entries.add(new FileEntry(folder,name,entry.tags()==null?List.of():entry.tags(),entry.note(),entry.isPublic(),entry.versions()));
        }
        Info info=manifest.project();
        String name=truncate(safeName(info.name())+" (导入)",128);
        long quotaBytes=info.quotaBytes()>0?Math.max(info.quotaBytes(),bytes):0;
        long quotaFiles=info.quotaFiles()>0?Math.max(info.quotaFiles(),entries.size()):0;
        List<String> domains=new ArrayList<>();
        if (info.allowedDomains()!=null) for (String domain:info.allowedDomains())
            if (domain!=null && domain.matches("[A-Za-z0-9.-]{1,253}")) domains.add(domain);
        var created=projects.create(new ProjectDtos.Input(name,truncate(info.description(),4096),quotaBytes,quotaFiles,domains));
        UUID project=created.project().id();
        projects.bind(project,target,true);
        int versions=0;
        for (FileEntry file:entries) {
            for (VersionEntry version:file.versions()) {
                files.ingest(project,file.folderPath(),new PathUpload(objectDir.resolve(version.checksum()),file.originalName()));
                for (Map<String,Object> row:jdbc.queryForList("SELECT storage_config_id,storage_key FROM files WHERE project_id=? "
                        +"AND folder_path=? AND original_name=? AND deleted_at IS NULL",project,file.folderPath(),file.originalName())) {
                    UUID objectStorage=(UUID)row.get("storage_config_id");
                    String objectKey=(String)row.get("storage_key");
                    if (objectStorage!=null && objectKey!=null) written.add(new Written(objectStorage,objectKey));
                }
                versions++;
            }
            jdbc.update("UPDATE files SET tags=CAST(? AS jsonb),note=?,is_public=? WHERE project_id=? AND folder_path=? "
                    +"AND original_name=? AND deleted_at IS NULL",jsonArray(file.tags()),file.note(),file.isPublic(),
                    project,file.folderPath(),file.originalName());
            String stored=jdbc.queryForObject("SELECT checksum FROM files WHERE project_id=? AND folder_path=? "
                    +"AND original_name=? AND deleted_at IS NULL",String.class,project,file.folderPath(),file.originalName());
            String expected=file.versions().get(file.versions().size()-1).checksum();
            if (!expected.equals(stored)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        }
        return new Imported(project,name,entries.size(),versions,bytes);
    }

    private UUID defaultStorage() {
        try {
            return jdbc.queryForObject("SELECT id FROM storage_configs WHERE is_default AND enabled AND deleted_at IS NULL LIMIT 1",UUID.class);
        } catch (EmptyResultDataAccessException ex) { return null; }
    }

    private String jsonArray(List<String> values) {
        try { return json.writeValueAsString(values); }
        catch (IOException ex) { throw new IllegalStateException(ex); }
    }

    private static String safeName(String value) {
        if (value==null || value.isBlank()) return "项目";
        String cleaned=value.replaceAll("[\\p{Cntrl}]","").trim();
        return cleaned.isEmpty()?"项目":cleaned;
    }

    private static String truncate(String value,int max) {
        if (value==null) return null;
        return value.length()<=max?value:value.substring(0,max);
    }

    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }

    private static void copyBounded(InputStream in,OutputStream out,long limit,long[] total) throws IOException {
        byte[] buffer=new byte[65536]; int read;
        while ((read=in.read(buffer))!=-1) {
            total[0]+=read;
            if (total[0]>limit) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
            out.write(buffer,0,read);
        }
    }

    private static byte[] readBounded(InputStream in,long limit) throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        byte[] buffer=new byte[65536]; long total=0; int read;
        while ((read=in.read(buffer))!=-1) {
            total+=read;
            if (total>limit) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
            out.write(buffer,0,read);
        }
        return out.toByteArray();
    }

    private static void deleteTree(Path root) {
        try (var paths=Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path->{ try { Files.deleteIfExists(path); } catch (IOException ignored) {} });
        } catch (IOException ignored) {}
    }
}
