package com.ufm.storage;

import com.ufm.common.error.*;
import org.springframework.stereotype.Service;
import java.io.*;
import java.nio.file.*;
import java.util.UUID;

@Service
public class LocalObjects {
    private final StorageService configs;
    public LocalObjects(StorageService configs) { this.configs=configs; }

    public Path path(UUID storage,String key) {
        if (!configs.requireEnabled(storage).getProvider().equals("LOCAL")) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        if (key==null || !key.matches("[a-zA-Z0-9/_-]+") || key.contains("..")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        Path root=configs.localPath(configs.config(storage));
        Path target=root.resolve(key).normalize();
        if (!target.startsWith(root) || target.equals(root)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        for (Path cursor=target;cursor!=null;cursor=cursor.getParent())
            if (Files.isSymbolicLink(cursor)) throw new ApiException(ErrorCode.FORBIDDEN);
        return target;
    }

    public void put(UUID storage,String key,Path source) {
        Path target=path(storage,key);
        try {
            Files.createDirectories(target.getParent());
            path(storage,key);
            Files.copy(source,target);
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void remove(UUID storage,String key) {
        try { Files.deleteIfExists(path(storage,key)); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
}
