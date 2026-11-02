package com.ufm.file;

import jakarta.validation.constraints.*;
import java.time.OffsetDateTime;
import java.util.*;

public final class FileDtos {
    private FileDtos() {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FilePage")
    public record Page(List<View> items,long total,int page,int size) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileView")
    public record View(UUID id,UUID projectId,String originalName,String mime,long size,String category,
                       String status,boolean isPublic,String checksum,String folderPath,int version,OffsetDateTime createdAt,
                       List<String> tags,String note) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileFolderInput")
    public record FolderInput(@NotNull UUID projectId,@NotBlank String path) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileFolder")
    public record Folder(UUID id,UUID projectId,String path) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileEdit")
    public record Edit(@Size(max=512) String originalName,String folderPath,Boolean isPublic,
                       @Size(max=50) List<@Size(max=64) String> tags,@Size(max=4096) String note) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileCopy")
    public record Copy(String folderPath,@NotBlank String originalName) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileFolderMove")
    public record FolderMove(@NotNull UUID projectId,@NotBlank String source,@NotBlank String target) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileBatch")
    public record Batch(@NotEmpty @Size(max=200) List<@NotNull UUID> ids) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileBatchMove")
    public record BatchMove(@NotEmpty @Size(max=200) List<@NotNull UUID> ids,@NotBlank String folderPath) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="FileVersion")
    public record Version(UUID id,int version,String originalName,long size,String checksum,OffsetDateTime createdAt) {}
}
