package com.ufm.backup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.config.UfmCryptoProperties;
import com.ufm.common.error.*;
import com.ufm.file.ArchiveSafety;
import com.ufm.storage.ObjectStore;
import com.ufm.task.TaskService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.zip.*;

@Service
public class BackupService {
    private final BackupMapper mapper;
    private final TaskService tasks;
    private final ObjectStore objects;
    private final ObjectMapper json;
    private final byte[] key;
    private final Path root;
    private final String pgDump,psql,url,user,password;
    private com.ufm.common.persistence.MaintenanceGate maintenance;
    @org.springframework.beans.factory.annotation.Autowired private org.springframework.beans.factory.ObjectProvider<RemoteBackupService> remote;
    @org.springframework.beans.factory.annotation.Autowired
    void setMaintenanceGate(com.ufm.common.persistence.MaintenanceGate gate) { maintenance=gate; }
    @org.springframework.beans.factory.annotation.Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbc;
    public BackupService(BackupMapper mapper,TaskService tasks,ObjectStore objects,ObjectMapper json,UfmCryptoProperties crypto,
                         @Value("${ufm.backup.path:${java.io.tmpdir}/ufm-backups}") String root,
                         @Value("${ufm.backup.pg-dump:pg_dump}") String pgDump,@Value("${ufm.backup.psql:psql}") String psql,
                         @Value("${spring.datasource.url}") String url,@Value("${spring.datasource.username}") String user,
                         @Value("${spring.datasource.password}") String password) {
        this.mapper=mapper; this.tasks=tasks; this.objects=objects; this.json=json; this.key=Base64.getDecoder().decode(crypto.getKey());
        this.root=Path.of(root).toAbsolutePath().normalize(); this.pgDump=pgDump; this.psql=psql; this.url=url; this.user=user; this.password=password;
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="BackupView")
    public record View(UUID id,String status,boolean includeObjects,String fileName,Long size,String checksum,String error) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="BackupEntry")
    public record Entry(UUID storageId,String key,String entry,String checksum) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="BackupManifest")
    public record Manifest(String format,String databaseChecksum,List<Entry> objects) {}
    public View create(boolean includeObjects) {
        UUID id=UUID.randomUUID(); mapper.create(id,includeObjects,"ufm-"+id+".zip");
        tasks.enqueue(null,"BACKUP",Map.of("backupId",id.toString())); return get(id);
    }
    public View get(UUID id) {
        var row=require(id); return new View(id,row.status(),row.includeObjects(),row.fileName(),row.size(),row.checksum(),row.error());
    }
    public List<View> list() { return mapper.list().stream().map(r->get(r.id())).toList(); }
    public View importBackup(org.springframework.web.multipart.MultipartFile upload) throws Exception {
        Files.createDirectories(root); UUID id=UUID.randomUUID(); Path target=archive(id); boolean accepted=false;
        try {
            try (var in=upload.getInputStream(); var out=Files.newOutputStream(target,StandardOpenOption.CREATE_NEW)) {
                byte[] buffer=new byte[65536]; long size=0; int n;
                while ((n=in.read(buffer))!=-1) { size+=n; if (size>100L*1024*1024*1024) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE); out.write(buffer,0,n); }
            }
            Manifest manifest=verify(target);
            mapper.create(id,!manifest.objects().isEmpty(),"ufm-"+id+".zip"); mapper.done(id,Files.size(target),hash(target),target.toString()); accepted=true;
            return get(id);
        } finally { if (!accepted) Files.deleteIfExists(target); }
    }
    public void delete(UUID id) throws Exception {
        var row=require(id); if (row.status().equals("RUNNING") || mapper.busy(id)) throw new ApiException(ErrorCode.CONFLICT);
        Files.deleteIfExists(archive(id)); mapper.delete(id);
    }
    public void restore(UUID id,String confirmation) {
        var row=require(id); if (!row.status().equals("DONE") || !"RESTORE".equals(confirmation)) throw new ApiException(ErrorCode.CONFLICT);
        tasks.enqueue(null,"PROJECT_IMPORT",Map.of("backupId",id.toString(),"restoreSystem",true));
    }
    public ResponseEntity<FileSystemResource> download(UUID id) {
        var row=require(id); if (!row.status().equals("DONE")) throw new ApiException(ErrorCode.CONFLICT);
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM).header("Cache-Control","no-store")
                .header("Content-Disposition",ContentDisposition.attachment().filename(row.fileName()).build().toString())
                .body(new FileSystemResource(archive(id)));
    }
    public void execute(UUID id) throws Exception {
        try (var lease=maintenance.exclusive()) { executeLocked(id); }
        try (var lease=maintenance.shared()) {
            var target=remote.getIfAvailable(); if (target!=null) target.sync(id,archive(id));
        }
    }
    private void executeLocked(UUID id) throws Exception {
        var row=require(id); mapper.start(id); Files.createDirectories(root);
        Path work=Files.createTempDirectory(root,"backup-work-"); Path sql=work.resolve("database.sql"),output=archive(id);
        try {
            run(pgDump,List.of("--clean","--if-exists","--no-owner","--no-privileges","--file",sql.toString()),work);
            List<Entry> entries=new ArrayList<>();
            try (ZipOutputStream zip=new ZipOutputStream(Files.newOutputStream(output))) {
                add(zip,"database.sql",sql);
                if (row.includeObjects()) {
                    int index=0;
                    for (var object:mapper.objects()) {
                        Path temp=work.resolve("object"); objects.get(object.storageConfigId(),object.storageKey(),temp);
                        String name="objects/"+index++; String digest=hash(temp); add(zip,name,temp); Files.delete(temp);
                        entries.add(new Entry(object.storageConfigId(),object.storageKey(),name,digest));
                    }
                }
                byte[] manifest=json.writeValueAsBytes(new Manifest("ufm-v2",hash(sql),entries));
                zip.putNextEntry(new ZipEntry("manifest.json")); zip.write(manifest); zip.closeEntry();
                zip.putNextEntry(new ZipEntry("manifest.hmac")); zip.write(sign(manifest)); zip.closeEntry();
            }
            mapper.done(id,Files.size(output),hash(output),output.toString());
        } finally { clean(work); }
    }
    public void executeRestore(UUID id) throws Exception {
        try (var lease=maintenance.exclusive()) { restoreLocked(id); }
    }
    private void restoreLocked(UUID id) throws Exception {
        var row=require(id); Path archive=archive(id);
        if (!hash(archive).equals(row.checksum())) throw new ApiException(ErrorCode.CONFLICT);
        verify(archive);
        Path work=Files.createTempDirectory(root,"restore-work-");
        try (ZipFile zip=new ZipFile(archive.toFile())) {
            byte[] encoded=read(zip,"manifest.json",16*1024*1024),signature=read(zip,"manifest.hmac",128);
            if (!MessageDigest.isEqual(sign(encoded),signature)) throw new ApiException(ErrorCode.FORBIDDEN);
            Manifest manifest=json.readValue(encoded,Manifest.class);
            if (!manifest.format().equals("ufm-v2")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            Path sql=work.resolve("database.sql"); extract(zip,"database.sql",sql);
            if (!hash(sql).equals(manifest.databaseChecksum())) throw new ApiException(ErrorCode.CONFLICT);
            for (Entry object:manifest.objects()) {
                Path temp=work.resolve("object"); extract(zip,object.entry(),temp);
                if (!hash(temp).equals(object.checksum())) throw new ApiException(ErrorCode.CONFLICT);
                Files.delete(temp);
            }
            maintenance.beginRestore();
            run(psql,List.of("--single-transaction","--set","ON_ERROR_STOP=1","--file",sql.toString()),work);
            // The snapshot predates completion of its own archive; retain recovery metadata for retries.
            if (mapper.get(id)==null) mapper.create(id,row.includeObjects(),row.fileName());
            mapper.done(id,Files.size(archive),row.checksum(),archive.toString());
            jdbc.update("UPDATE refresh_tokens SET revoked_at=now() WHERE revoked_at IS NULL");
            jdbc.update("UPDATE tasks SET status='CANCELED',locked_by=NULL,locked_until=NULL,finished_at=now() WHERE status IN ('RUNNING','PENDING','PAUSED')");
            jdbc.update("INSERT INTO settings(key,value) VALUES('auth.initialized','true'::jsonb) ON CONFLICT(key) DO NOTHING");
            for (Entry object:manifest.objects()) {
                Path temp=work.resolve("object"); extract(zip,object.entry(),temp);
                if (objects.local(object.storageId())) {
                    Path existing=objects.path(object.storageId(),object.key());
                    if (!Files.exists(existing)) objects.put(object.storageId(),object.key(),temp);
                    else if (!hash(existing).equals(object.checksum())) { Files.delete(existing); objects.put(object.storageId(),object.key(),temp); }
                } else objects.put(object.storageId(),object.key(),temp);
                Files.delete(temp);
            }
            maintenance.finishRestore();
        } finally { clean(work); }
    }
    private Manifest verify(Path archive) throws Exception {
        // Authenticate the manifest before trusting advertised object sizes or decompressing payloads.
        try (ZipFile zip=new ZipFile(archive.toFile())) {
            byte[] encoded=read(zip,"manifest.json",16*1024*1024),signature=read(zip,"manifest.hmac",128);
            if (!MessageDigest.isEqual(sign(encoded),signature)) throw new ApiException(ErrorCode.FORBIDDEN);
            Manifest manifest=json.readValue(encoded,Manifest.class);
            if (!"ufm-v2".equals(manifest.format()) || manifest.objects()==null || manifest.objects().size()>100000) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            Set<String> expected=new HashSet<>(List.of("database.sql","manifest.json","manifest.hmac"));
            for (Entry object:manifest.objects()) {
                if (object.storageId()==null || object.key()==null || !object.entry().matches("objects/[0-9]+") || !expected.add(object.entry())) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            }
            Set<String> found=new HashSet<>(); long expanded=0;
            for (var entries=zip.entries();entries.hasMoreElements();) {
                var entry=entries.nextElement();
                if (entry.isDirectory() || !expected.contains(entry.getName()) || !found.add(entry.getName()) || entry.getSize()<0) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                expanded=Math.addExact(expanded,entry.getSize()); if (expanded>1024L*1024*1024*1024) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
            }
            if (!found.equals(expected)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            if (!hashEntry(zip,"database.sql").equals(manifest.databaseChecksum())) throw new ApiException(ErrorCode.CONFLICT);
            for (Entry object:manifest.objects()) if (!hashEntry(zip,object.entry()).equals(object.checksum())) throw new ApiException(ErrorCode.CONFLICT);
            return manifest;
        }
    }
    private String hashEntry(ZipFile zip,String name) throws Exception {
        var entry=zip.getEntry(name); MessageDigest digest=MessageDigest.getInstance("SHA-256"); long total=0;
        try (var input=zip.getInputStream(entry)) {
            byte[] buffer=new byte[65536]; int n;
            while ((n=input.read(buffer))!=-1) { total+=n; if (total>entry.getSize()) throw new ApiException(ErrorCode.INVALID_ARGUMENT); digest.update(buffer,0,n); }
        }
        if (total!=entry.getSize()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return HexFormat.of().formatHex(digest.digest());
    }
    private void run(String executable,List<String> args,Path work) throws Exception {
        URI database=URI.create(url.substring(5)); List<String> command=new ArrayList<>(); command.add(executable);
        command.addAll(List.of("--host",database.getHost(),"--port",Integer.toString(database.getPort()<0?5432:database.getPort()),
                "--username",user,"--dbname",database.getPath().substring(1),"--no-password")); command.addAll(args);
        ProcessBuilder process=new ProcessBuilder(command); process.environment().put("PGPASSWORD",password);
        process.redirectError(work.resolve("process.err").toFile()); process.redirectOutput(work.resolve("process.out").toFile());
        Process child=process.start();
        if (!child.waitFor(10,TimeUnit.MINUTES)) { child.destroyForcibly(); throw new ApiException(ErrorCode.UPSTREAM_TIMEOUT); }
        if (child.exitValue()!=0) {
            org.slf4j.LoggerFactory.getLogger(BackupService.class).error("Database tool {} failed: {}",executable,
                    new String(Files.readAllBytes(work.resolve("process.err")),java.nio.charset.Charset.forName(System.getProperty("native.encoding","UTF-8"))));
            throw new ApiException(ErrorCode.INTERNAL_ERROR,"Backup database operation failed");
        }
    }
    private BackupMapper.Row require(UUID id) { var row=mapper.get(id); if (row==null) throw new ApiException(ErrorCode.NOT_FOUND); return row; }
    private Path archive(UUID id) { return root.resolve("ufm-"+id+".zip"); }
    private void add(ZipOutputStream zip,String name,Path file) throws IOException { zip.putNextEntry(new ZipEntry(name)); Files.copy(file,zip); zip.closeEntry(); }
    private byte[] read(ZipFile zip,String entry,int max) throws IOException {
        var item=zip.getEntry(entry); if (item==null) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        try (var input=zip.getInputStream(item)) { byte[] data=input.readNBytes(max+1); if (data.length>max) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE); return data; }
    }
    private void extract(ZipFile zip,String name,Path file) throws IOException {
        var entry=zip.getEntry(name); if (entry==null) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        try (var input=zip.getInputStream(entry)) { Files.copy(input,file); }
    }
    private String hash(Path file) throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256"); try (var input=Files.newInputStream(file)) {
            byte[] buffer=new byte[65536]; int n; while ((n=input.read(buffer))!=-1) digest.update(buffer,0,n);
        } return HexFormat.of().formatHex(digest.digest());
    }
    private byte[] sign(byte[] data) throws Exception { Mac mac=Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key,"HmacSHA256")); return mac.doFinal(data); }
    private void clean(Path work) throws IOException {
        Path absolute=work.toAbsolutePath().normalize(); if (!absolute.startsWith(root) || absolute.equals(root)) throw new IOException("Unsafe cleanup");
        try (var entries=Files.list(work)) { for (Path entry:entries.toList()) Files.delete(entry); } Files.delete(work);
    }
}
