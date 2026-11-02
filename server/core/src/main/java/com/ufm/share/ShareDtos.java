package com.ufm.share;

import jakarta.validation.constraints.*;
import java.time.OffsetDateTime;
import java.util.*;

public final class ShareDtos {
    private ShareDtos() {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ShareInput")
    public record Input(UUID fileId,UUID folderId,@Size(max=72) String password,OffsetDateTime expiresAt,
                        @Min(1) Long maxDownloads,boolean previewOnly,@Size(max=100) List<String> allowedIps,
                        @Size(max=256) String watermark,@Pattern(regexp="[a-zA-Z0-9_-]{3,64}") String customPath) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ShareView")
    public record View(UUID id,UUID fileId,UUID folderId,String token,String customPath,OffsetDateTime expiresAt,
                       Long maxDownloads,long downloadCount,boolean previewOnly,boolean enabled,String watermark,boolean passwordProtected,List<String> allowedIps) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="SharePublicFile")
    public record PublicFile(UUID id,String originalName,String mime,long size) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="SharePublicPage")
    public record PublicPage(List<PublicFile> items,long total,int page,int size) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="SharePublicFolder")
    public record PublicFolder(String name,String path) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ShareFolderPage")
    public record FolderPage(String path,List<PublicFolder> folders,List<PublicFile> items,long total,int page,int size,boolean previewOnly,String watermark) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="SharePublicView")
    public record PublicView(PublicFile file,boolean previewOnly,String watermark) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="SharePassword")
    public record Password(@NotBlank @Size(max=72) String password) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ShareEdit")
    public record Edit(Boolean enabled,Boolean previewOnly,OffsetDateTime expiresAt,@Min(1) Long maxDownloads,
                       @Size(max=256) String watermark,@Size(max=72) String password,boolean removePassword,
                       boolean clearExpiration,boolean clearDownloadLimit,@Size(max=100) List<String> allowedIps) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ShareLibrary")
    public record Library(@NotNull UUID projectId,boolean enabled,@NotBlank @Pattern(regexp="[a-zA-Z0-9_-]{3,64}") String slug) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ShareBan")
    public record Ban(@NotBlank String ip,boolean permanent,OffsetDateTime until,@Size(max=256) String reason) {}
}
