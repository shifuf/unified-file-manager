package com.ufm.file;

import com.ufm.storage.ObjectStore;
import com.ufm.file.search.SearchTextTokenizer;
import org.springframework.stereotype.Service;
import java.nio.file.*;
import java.util.UUID;

@Service
public class SearchIndexService {
    private final FileService files;
    private final FileMapper mapper;
    private final ObjectStore objects;
    public SearchIndexService(FileService files,FileMapper mapper,ObjectStore objects) { this.files=files; this.mapper=mapper; this.objects=objects; }
    public void index(UUID id) throws Exception {
        var file=files.require(id,false); Path temp=Files.createTempFile("ufm-search-",".bin");
        try {
            Files.delete(temp); objects.get(file.getStorageConfigId(),file.getStorageKey(),temp);
            String content=DocumentText.extract(temp,file.getMime());
            mapper.searchIndex(id,file.getVersion(),file.getStorageKey(),content,new SearchTextTokenizer().tokenize(file.getOriginalName()+" "+content));
        } finally { Files.deleteIfExists(temp); }
    }
    public void inspect(UUID id,int version,String key) throws Exception {
        var file=mapper.selectById(id);
        if (file==null || file.getDeletedAt()!=null || !"ACTIVE".equals(file.getStatus()) || file.getVersion()!=version || !file.getStorageKey().equals(key)) return;
        Path temp=Files.createTempFile("ufm-inspect-",".bin");
        try {
            Files.delete(temp); objects.get(file.getStorageConfigId(),key,temp);
            String mime=FileService.sniff(temp,file.getOriginalName());
            try {
                if (Files.size(temp)!=file.getSize()) { files.quarantine(file); return; }
                if (mime.equals("application/zip") || mime.startsWith("application/vnd.openxmlformats"))
                    ArchiveSafety.check(temp,10000,1024L*1024*1024);
            } catch (com.ufm.common.error.ApiException ex) { files.quarantine(file); return; }
            var hash=java.security.MessageDigest.getInstance("SHA-256");
            try (var input=Files.newInputStream(temp)) {
                byte[] buffer=new byte[65536]; int count;
                while ((count=input.read(buffer))!=-1) hash.update(buffer,0,count);
            }
            String content="";
            if (mime.startsWith("text/")) try (var input=Files.newInputStream(temp)) {
                content=new String(input.readNBytes(512*1024),java.nio.charset.StandardCharsets.UTF_8);
            }
            else if (mime.startsWith("application/vnd.openxmlformats") || mime.equals("application/pdf")) content=DocumentText.extract(temp,mime);
            files.completeInspection(file,mime,java.util.HexFormat.of().formatHex(hash.digest()),content);
        } finally { Files.deleteIfExists(temp); }
    }
}
