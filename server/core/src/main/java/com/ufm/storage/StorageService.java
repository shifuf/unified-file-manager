package com.ufm.storage;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.crypto.SecretCipher;
import com.ufm.common.error.*;
import com.ufm.generated.entity.StorageConfigsEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.*;

@Service
public class StorageService {
    private final StorageMapper mapper;
    private final SecretCipher cipher;
    private final ObjectMapper json;
    @org.springframework.beans.factory.annotation.Autowired private org.springframework.beans.factory.ObjectProvider<S3Objects> s3;
    @org.springframework.beans.factory.annotation.Autowired private org.springframework.beans.factory.ObjectProvider<OssObjects> oss;
    @org.springframework.beans.factory.annotation.Autowired private org.springframework.beans.factory.ObjectProvider<QiniuObjects> qiniu;
    @org.springframework.beans.factory.annotation.Autowired private org.springframework.beans.factory.ObjectProvider<UpyunObjects> upyun;
    public StorageService(StorageMapper mapper,SecretCipher cipher,ObjectMapper json) {
        this.mapper=mapper; this.cipher=cipher; this.json=json;
    }
    public List<StorageDtos.View> list() {
        return mapper.selectList(new QueryWrapper<StorageConfigsEntity>().isNull("deleted_at").orderByAsc("priority")
                .last("LIMIT 500")).stream().map(this::view).toList();
    }
    public StorageConfigsEntity requireEnabled(UUID id) {
        StorageConfigsEntity row=mapper.selectById(id);
        if (row==null || row.getDeletedAt()!=null) throw new ApiException(ErrorCode.STORAGE_NOT_FOUND);
        if (!Boolean.TRUE.equals(row.getEnabled())) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        return row;
    }

    @Transactional
    public StorageDtos.View create(StorageDtos.Input input) {
        if (input.provider().equals("LOCAL")) localPath(input.config());
        StorageConfigsEntity row=new StorageConfigsEntity(); row.setId(UUID.randomUUID());
        row.setName(input.name()); row.setProvider(input.provider()); row.setEnabled(true);
        row.setIsDefault(false); row.setPriority(100); mapper.insert(row);
        mapper.config(row.getId(),encode(Map.of("enc",cipher.encrypt(encode(input.config())))));
        return view(requireEnabled(row.getId()));
    }

    public StorageDtos.View get(UUID id) { return view(requireEnabled(id)); }
    public StorageDtos.Policy policy(UUID id) {
        var row=requireEnabled(id);
        return new StorageDtos.Policy(row.getPriority(),row.getStorageQuotaBytes()==null?0:row.getStorageQuotaBytes(),
                row.getTrafficQuotaBytes()==null?0:row.getTrafficQuotaBytes(),row.getFailoverThresholdPct(),
                row.getAutoFailover(),row.getManualStorageBytes(),row.getManualTrafficBytes());
    }
    public StorageDtos.Policy policy(UUID id,StorageDtos.Policy input) { requireEnabled(id); mapper.policy(id,input); return input; }

    @Transactional
    public StorageDtos.View update(UUID id,StorageDtos.Edit input) {
        StorageConfigsEntity row=requireEnabled(id);
        Map<String,Object> values=new HashMap<>(config(id));
        input.config().forEach((key,value)-> { if (!"***".equals(value)) values.put(key,value); });
        if (row.getProvider().equals("LOCAL")) localPath(values);
        mapper.config(id,encode(Map.of("enc",cipher.encrypt(encode(values))))); mapper.rename(id,input.name());
        return get(id);
    }

    @Transactional
    public void delete(UUID id) {
        requireEnabled(id);
        if (mapper.bound(id)) throw new ApiException(ErrorCode.CONFLICT);
        mapper.softDelete(id);
    }

    @Transactional
    public StorageDtos.View makeDefault(UUID id) {
        mapper.lockDefaults(); StorageConfigsEntity row=requireEnabled(id);
        mapper.clearDefault(); row.setConfig(null); row.setLastHealth(null); row.setLastUsage(null);
        row.setIsDefault(true); mapper.updateById(row); return get(id);
    }

    /** Id of the enabled default storage, or null when none is configured. */
    public UUID defaultEnabled() { return mapper.defaultEnabledId(); }

    public Map<String,Object> config(UUID id) {
        try {
            StorageConfigsEntity row=requireEnabled(id);
            String encrypted=json.readTree(row.getConfig()).path("enc").asText();
            return json.readValue(cipher.decrypt(encrypted),new TypeReference<>(){});
        } catch (ApiException ex) { throw ex; }
        catch (Exception ex) { throw new IllegalStateException("Unable to decode storage configuration",ex); }
    }

    public StorageDtos.Probe probe(UUID id) {
        StorageConfigsEntity row=requireEnabled(id);
        return probeConfig(row.getProvider(),config(id));
    }

    public Map<String,Object> usage(UUID id) {
        StorageConfigsEntity row=requireEnabled(id);
        if (row.getManualStorageBytes()!=null)
            return Map.of("source","manual","usedBytes",row.getManualStorageBytes());
        if (row.getLastUsage()!=null) try {
            Map<String,Object> value=json.readValue(row.getLastUsage(),new TypeReference<>(){});
            if (value.get("usedBytes") instanceof Number) return value;
        } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        return Map.of("source","unknown");
    }
    public void refreshSnapshots() {
        for (var storage:list()) {
            UUID id=storage.id(); Map<String,Object> usage=Map.of("source","unknown");
            Map<String,Object> health; String time=java.time.Instant.now().toString();
            try {
                probe(id); health=Map.of("success",true,"checkedAt",time);
                if (storage.provider().equals("LOCAL")) {
                    Path root=localPath(config(id)); long[] bytes={0}; long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(30);
                    Files.walkFileTree(root,new SimpleFileVisitor<>() {
                        @Override public FileVisitResult preVisitDirectory(Path dir,java.nio.file.attribute.BasicFileAttributes attributes) throws java.io.IOException {
                            if (System.nanoTime()>deadline || Thread.currentThread().isInterrupted()) throw new java.io.IOException("Usage scan interrupted");
                            return FileVisitResult.CONTINUE;
                        }
                        @Override public FileVisitResult visitFile(Path file,java.nio.file.attribute.BasicFileAttributes attributes) throws java.io.IOException {
                            if (System.nanoTime()>deadline || Thread.currentThread().isInterrupted()) throw new java.io.IOException("Usage scan interrupted");
                            if (attributes.isRegularFile()) bytes[0]=Math.addExact(bytes[0],attributes.size()); return FileVisitResult.CONTINUE;
                        }
                    });
                    usage=Map.of("source","platform","usedBytes",bytes[0],"checkedAt",time);
                }
            } catch (RuntimeException | java.io.IOException ex) { health=Map.of("success",false,"checkedAt",time,"message","Storage check failed"); }
            mapper.snapshot(id,encode(usage),encode(health));
        }
    }

    public StorageDtos.Probe probeDraft(StorageDtos.Input input) {
        return probeConfig(input.provider(),input.config());
    }

    private StorageDtos.Probe probeConfig(String provider,Map<String,Object> config) {
        if (provider.equals("S3")) return s3.getObject().probe(config);
        if (provider.equals("OSS")) return oss.getObject().probe(config);
        if (provider.equals("QINIU")) return qiniu.getObject().probe(config);
        if (provider.equals("UPYUN")) return upyun.getObject().probe(config);
        if (!provider.equals("LOCAL")) throw new ApiException(ErrorCode.STORAGE_PATH_INVALID);
        long start=System.nanoTime(); Path probe=null;
        try {
            // 本地存储路径允许“尚不存在”：先尝试创建，再校验它是可写目录。
            // 只有创建失败或确实不可写时才返回 STORAGE_PATH_INVALID，便于用户按提示修路径。
            Path root=localPath(config);
            try { Files.createDirectories(root); }
            catch (java.io.IOException ex) { throw new ApiException(ErrorCode.STORAGE_PATH_INVALID); }
            if (!Files.isDirectory(root,java.nio.file.LinkOption.NOFOLLOW_LINKS)
                    || !Files.isWritable(root)) throw new ApiException(ErrorCode.STORAGE_PATH_INVALID);
            probe=Files.createTempFile(root,".ufm-probe-",".tmp");
            byte[] expected=new byte[1024]; new SecureRandom().nextBytes(expected);
            Files.write(probe,expected,StandardOpenOption.TRUNCATE_EXISTING);
            if (!Arrays.equals(expected,Files.readAllBytes(probe))) throw new java.io.IOException("Probe mismatch");
            return new StorageDtos.Probe(true,(System.nanoTime()-start)/1_000_000);
        } catch (java.io.IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        catch (ApiException ex) { throw ex; }
        finally { if (probe!=null) try { Files.deleteIfExists(probe); } catch (java.io.IOException ignored) {} }
    }

    public Path localPath(Map<String,Object> config) {
        Object value=config.get("basePath");
        if (!(value instanceof String path) || path.isBlank()) throw new ApiException(ErrorCode.VALIDATION_FAILED);
        try {
            Path root=Path.of(path);
            if (!root.isAbsolute()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            return root.normalize();
        } catch (InvalidPathException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }

    public StorageDtos.View configuration(UUID id) {
        StorageConfigsEntity row=requireEnabled(id);
        Map<String,String> masked=new HashMap<>();
        config(row.getId()).forEach((key,value)->{
            // Only allow-listed non-secret fields leave the encrypted configuration boundary.
            if (Set.of("basePath","endpoint","bucket","region","customDomain","service","uploadEndpoint","rsEndpoint","private").contains(key)) masked.put(key,String.valueOf(value));
            else masked.put(key,"***");
        });
        masked.putIfAbsent("secretKey","***");
        return new StorageDtos.View(row.getId(),row.getName(),row.getProvider(),row.getEnabled(),row.getIsDefault(),
                row.getPriority(),masked);
    }
    private StorageDtos.View view(StorageConfigsEntity row) {
        return new StorageDtos.View(row.getId(),row.getName(),row.getProvider(),row.getEnabled(),row.getIsDefault(),row.getPriority(),Map.of("secretKey","***"));
    }
    private String encode(Object value) {
        try { return json.writeValueAsString(value); }
        catch (Exception ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }
}
