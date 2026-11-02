package com.ufm.storage;

import org.springframework.stereotype.Service;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;

@Service
public class ObjectStore {
    private final StorageService configs;
    private final LocalObjects local;
    private final S3Objects s3;
    @org.springframework.beans.factory.annotation.Autowired private OssObjects oss;
    private boolean oss(UUID id) { return configs.requireEnabled(id).getProvider().equals("OSS"); }
    @org.springframework.beans.factory.annotation.Autowired private QiniuObjects qiniu;
    @org.springframework.beans.factory.annotation.Autowired private UpyunObjects upyun;
    private boolean qiniu(UUID id) { return configs.requireEnabled(id).getProvider().equals("QINIU"); }
    private boolean upyun(UUID id) { return configs.requireEnabled(id).getProvider().equals("UPYUN"); }
    @org.springframework.beans.factory.annotation.Autowired private org.springframework.beans.factory.ObjectProvider<com.ufm.notify.FailureNotification> failures;
    @org.springframework.beans.factory.annotation.Autowired private StorageMapper mapper;
    public ObjectStore(StorageService configs,LocalObjects local,S3Objects s3) { this.configs=configs; this.local=local; this.s3=s3; }
    public boolean local(UUID id) { return configs.requireEnabled(id).getProvider().equals("LOCAL"); }
    public void put(UUID id,String key,Path path) {
        try {
            if (local(id)) local.put(id,key,path);
            else if (oss(id)) oss.put(id,key,path);
            else if (qiniu(id)) qiniu.put(id,key,path);
            else if (upyun(id)) upyun.put(id,key,path);
            else s3.put(id,key,path);
        }
        catch (com.ufm.common.error.ApiException ex) { report(id,ex); throw ex; }
    }
    public void remove(UUID id,String key) {
        if (local(id)) local.remove(id,key);
        else if (oss(id)) oss.remove(id,key);
        else if (qiniu(id)) qiniu.remove(id,key);
        else if (upyun(id)) upyun.remove(id,key);
        else s3.remove(id,key);
    }
    public Path path(UUID id,String key) { return local.path(id,key); }
    public String downloadUrl(UUID id,String key) {
        if (oss(id)) return oss.getUrl(id,key);
        if (qiniu(id)) return qiniu.url(id,key);
        if (upyun(id)) return upyun.url(id,key);
        return s3.getUrl(id,key);
    }
    public String putUrl(UUID id,String key,long size) {
        if (oss(id)) return oss.putUrl(id,key);
        s3Compatible(id);
        return s3.putUrl(id,key,size);
    }
    public String seal(UUID id,String source,String target,long size) {
        if (oss(id)) return oss.seal(id,source,target,size);
        s3Compatible(id);
        return s3.seal(id,source,target,size);
    }
    public String multipart(UUID id,String key) {
        if (oss(id)) return oss.multipart(id,key);
        s3Compatible(id);
        return s3.multipart(id,key);
    }
    public String partUrl(UUID id,String key,String upload,int part) {
        if (oss(id)) return oss.partUrl(id,key,upload,part);
        s3Compatible(id);
        return s3.partUrl(id,key,upload,part);
    }
    public void complete(UUID id,String key,String upload,java.util.List<software.amazon.awssdk.services.s3.model.CompletedPart> parts) {
        if (oss(id)) { oss.complete(id,key,upload,parts); return; }
        s3Compatible(id);
        s3.complete(id,key,upload,parts);
    }
    public void abort(UUID id,String key,String upload) {
        if (oss(id)) { oss.abort(id,key,upload); return; }
        s3Compatible(id);
        s3.abort(id,key,upload);
    }
    public Form form(UUID id,String key,long size) {
        if (qiniu(id)) { var form=qiniu.form(id,key,size); return new Form(form.uploadUrl(),form.fields(),form.expiresIn()); }
        if (upyun(id)) { var form=upyun.form(id,key,size); return new Form(form.uploadUrl(),form.fields(),form.expiresIn()); }
        throw new com.ufm.common.error.ApiException(com.ufm.common.error.ErrorCode.STORAGE_UNAVAILABLE);
    }
    public void copy(UUID id,String source,String target) {
        if (qiniu(id)) { qiniu.copy(id,source,target); return; }
        if (upyun(id)) { upyun.copy(id,source,target); return; }
        throw new com.ufm.common.error.ApiException(com.ufm.common.error.ErrorCode.STORAGE_UNAVAILABLE);
    }
    public record Form(String uploadUrl,Map<String,String> fields,long expiresIn) {}
    public java.io.InputStream openRange(UUID id,String key,long start,long length) {
        if (oss(id)) return oss.openRange(id,key,start,length);
        if (qiniu(id)) return qiniu.openRange(id,key,start,length);
        if (upyun(id)) return upyun.openRange(id,key,start,length);
        return s3.openRange(id,key,start,length);
    }
    public long size(UUID id,String key) {
        if (qiniu(id)) return qiniu.size(id,key);
        if (upyun(id)) return upyun.size(id,key);
        if (!local(id)) return oss(id)?oss.size(id,key):s3.size(id,key);
        try { return java.nio.file.Files.size(local.path(id,key)); }
        catch (java.io.IOException ex) { throw new com.ufm.common.error.ApiException(com.ufm.common.error.ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void get(UUID id,String key,Path target) {
        try { getObject(id,key,target); }
        catch (com.ufm.common.error.ApiException ex) { report(id,ex); throw ex; }
    }
    private void getObject(UUID id,String key,Path target) {
        if (local(id)) try { java.nio.file.Files.copy(local.path(id,key),target); }
        catch (java.io.IOException ex) { throw new com.ufm.common.error.ApiException(com.ufm.common.error.ErrorCode.STORAGE_UNAVAILABLE); }
        else if (oss(id)) oss.get(id,key,target);
        else if (qiniu(id)) qiniu.get(id,key,target);
        else if (upyun(id)) upyun.get(id,key,target);
        else s3.get(id,key,target);
    }
    private void report(UUID storage,com.ufm.common.error.ApiException error) {
        if (error.getCode()!=com.ufm.common.error.ErrorCode.STORAGE_UNAVAILABLE) return;
        try {
            var notification=failures.getIfAvailable(); if (notification==null) return;
            for (UUID project:mapper.projects(storage)) notification.emit(project,"STORAGE_FAILED",java.util.Map.of("storageId",storage.toString(),"message","Storage operation failed"));
        } catch (RuntimeException ex) {
            org.slf4j.LoggerFactory.getLogger(ObjectStore.class).warn("Unable to enqueue storage failure notification for {}",storage);
        }
    }
    private void s3Compatible(UUID id) {
        if (!configs.requireEnabled(id).getProvider().equals("S3"))
            throw new com.ufm.common.error.ApiException(com.ufm.common.error.ErrorCode.STORAGE_UNAVAILABLE);
    }
}
