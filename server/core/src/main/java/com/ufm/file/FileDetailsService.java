package com.ufm.file;

import com.ufm.storage.StorageService;
import org.apache.ibatis.annotations.*;
import org.springframework.stereotype.Service;
import java.time.OffsetDateTime;
import java.util.*;

@Service
public class FileDetailsService {
    @io.swagger.v3.oas.annotations.media.Schema(name="FileStorageSummary")
    public record Storage(UUID id,String name,String provider) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileShareReference")
    public record Share(UUID id,String token,boolean enabled,boolean previewOnly,OffsetDateTime expiresAt) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileDetails")
    public record Details(FileDtos.View file,Storage storage,String accessRoute,long successfulDownloads,List<Share> shares) {}
    @Mapper public interface Queries {
        @Select("SELECT count(*) FROM download_records WHERE file_id=#{id} AND success") long downloads(UUID id);
        @Select("SELECT id,token,enabled,preview_only,expires_at FROM share_links WHERE file_id=#{id} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200") List<Share> shares(UUID id);
    }
    private final FileService files;
    private final StorageService storage;
    private final Queries queries;
    public FileDetailsService(FileService files,StorageService storage,Queries queries) { this.files=files; this.storage=storage; this.queries=queries; }
    public Details get(UUID id) {
        var file=files.require(id,false); var config=storage.requireEnabled(file.getStorageConfigId());
        return new Details(files.view(file),new Storage(config.getId(),config.getName(),config.getProvider()),
                config.getProvider().equals("LOCAL")?"SERVER_STREAM":"SIGNED_REDIRECT",queries.downloads(id),queries.shares(id));
    }
}
