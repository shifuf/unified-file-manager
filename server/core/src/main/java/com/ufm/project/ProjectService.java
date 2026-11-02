package com.ufm.project;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.auth.AuthService;
import com.ufm.common.crypto.SecretCipher;
import com.ufm.common.error.*;
import com.ufm.generated.entity.ProjectsEntity;
import com.ufm.storage.StorageService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.OffsetDateTime;
import java.util.*;

@Service
public class ProjectService {
    private final ProjectMapper mapper;
    private final SecretCipher cipher;
    private final ObjectMapper json;
    private final StorageService storage;
    public ProjectService(ProjectMapper mapper,SecretCipher cipher,ObjectMapper json,StorageService storage) {
        this.mapper=mapper; this.cipher=cipher; this.json=json; this.storage=storage;
    }
    public List<ProjectDtos.View> list() {
        return mapper.selectList(new QueryWrapper<ProjectsEntity>().isNull("deleted_at").orderByDesc("created_at")
                .last("LIMIT 500")).stream().map(this::view).toList();
    }
    public ProjectsEntity require(UUID id) {
        ProjectsEntity row=mapper.selectById(id);
        if (row==null || row.getDeletedAt()!=null) throw new ApiException(ErrorCode.PROJECT_NOT_FOUND);
        return row;
    }
    public ProjectDtos.View get(UUID id) { return view(require(id)); }

    @Transactional
    public Map<String,String> rotate(UUID id) {
        ProjectsEntity row=mapper.lock(id);
        if (row==null) throw new ApiException(ErrorCode.PROJECT_NOT_FOUND);
        String secret=AuthService.randomSecret(); row.setAllowedDomains(null);
        row.setSecretHash(AuthService.hash(secret)); row.setSecretEnc(cipher.encrypt(secret));
        mapper.updateById(row); mapper.addSecret(id,row.getSecretHash(),row.getSecretEnc());
        return Map.of("appSecret",secret);
    }

    @Transactional
    public ProjectDtos.Created create(ProjectDtos.Input input) {
        ProjectsEntity row=new ProjectsEntity(); row.setId(UUID.randomUUID());
        row.setAppId(AuthService.randomSecret().substring(0,24));
        row.setName(input.name()); row.setDescription(input.description()); row.setQuotaBytes(input.quotaBytes());
        row.setQuotaFiles(input.quotaFiles()); row.setUsedBytes(0L); row.setUsedFiles(0L);
        String secret=AuthService.randomSecret(); row.setSecretHash(AuthService.hash(secret)); row.setSecretEnc(cipher.encrypt(secret));
        mapper.insert(row); mapper.domains(row.getId(),encode(input.allowedDomains()==null?List.of():input.allowedDomains()));
        mapper.addSecret(row.getId(),row.getSecretHash(),row.getSecretEnc());
        // 新项目若已有默认存储则自动绑定并激活，避免首次上传报“存储配置不存在”。
        UUID defaultStorage=storage.defaultEnabled();
        if (defaultStorage!=null) mapper.bind(row.getId(),defaultStorage,true);
        return new ProjectDtos.Created(get(row.getId()),secret);
    }

    @Transactional
    public ProjectDtos.View update(UUID id,ProjectDtos.Input input) {
        ProjectsEntity row=mapper.lock(id);
        if (row==null) throw new ApiException(ErrorCode.PROJECT_NOT_FOUND);
        if ((input.quotaBytes()>0 && row.getUsedBytes()>input.quotaBytes()) ||
                (input.quotaFiles()>0 && row.getUsedFiles()>input.quotaFiles())) throw new ApiException(ErrorCode.QUOTA_EXHAUSTED);
        row.setName(input.name()); row.setDescription(input.description()); row.setQuotaBytes(input.quotaBytes());
        row.setQuotaFiles(input.quotaFiles()); row.setAllowedDomains(null); mapper.updateById(row);
        mapper.domains(id,encode(input.allowedDomains()==null?List.of():input.allowedDomains()));
        return get(id);
    }

    @Transactional
    public void delete(UUID id) {
        ProjectsEntity row=require(id); row.setAllowedDomains(null); row.setDeletedAt(OffsetDateTime.now()); mapper.updateById(row);
    }

    public List<ProjectDtos.Binding> bindings(UUID id) { require(id); return mapper.bindings(id); }

    @Transactional
    public ProjectDtos.Binding bind(UUID id,UUID configId,boolean active) {
        if (mapper.lock(id)==null) throw new ApiException(ErrorCode.PROJECT_NOT_FOUND);
        storage.requireEnabled(configId);
        if (active) mapper.deactivate(id);
        mapper.bind(id,configId,active);
        return mapper.bindings(id).stream().filter(b->b.configId().equals(configId)).findFirst().orElseThrow();
    }

    private ProjectDtos.View view(ProjectsEntity row) {
        List<String> domains;
        try { domains=json.readValue(row.getAllowedDomains(),new TypeReference<>(){}); }
        catch (Exception ex) { throw new IllegalStateException("Invalid project domain metadata",ex); }
        return new ProjectDtos.View(row.getId(),row.getAppId(),row.getName(),row.getDescription(),row.getQuotaBytes(),
                row.getQuotaFiles(),row.getUsedBytes(),row.getUsedFiles(),domains);
    }
    private String encode(Object value) {
        try { return json.writeValueAsString(value); }
        catch (Exception ex) { throw new IllegalArgumentException("Invalid project metadata",ex); }
    }
}
