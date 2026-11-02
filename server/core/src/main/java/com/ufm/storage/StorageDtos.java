package com.ufm.storage;

import jakarta.validation.constraints.*;
import java.util.*;

public final class StorageDtos {
    private StorageDtos() {}
    @io.swagger.v3.oas.annotations.media.Schema(name="StorageInput")
    public record Input(@NotBlank @Size(max=128) String name,
                        @NotBlank @Pattern(regexp="LOCAL|S3|QINIU|UPYUN|OSS") String provider,
                        @NotNull Map<String,Object> config) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="StorageView")
    public record View(UUID id,String name,String provider,boolean enabled,boolean isDefault,
                       int priority,Map<String,String> config) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="StorageProbe")
    public record Probe(boolean success,long elapsedMs) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="StorageEdit")
    public record Edit(@NotBlank @Size(max=128) String name,@NotNull Map<String,Object> config) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="StoragePolicy")
    public record Policy(int priority,@Min(0) long storageQuotaBytes,@Min(0) long trafficQuotaBytes,@Min(1) @Max(100) int threshold,
                         boolean autoFailover,@Min(0) Long manualStorageBytes,@Min(0) Long manualTrafficBytes) {}
}
