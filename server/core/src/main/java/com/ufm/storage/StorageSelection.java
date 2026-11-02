package com.ufm.storage;

import com.ufm.common.error.*;
import com.ufm.file.FileMapper;
import com.ufm.project.ProjectMapper;
import com.ufm.generated.entity.StorageConfigsEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import java.math.BigInteger;

@Service
public class StorageSelection {
    private final ProjectMapper projects;
    private final StorageMapper storage;
    private final FileMapper files;
    private final ObjectMapper json;
    public StorageSelection(ProjectMapper projects,StorageMapper storage,FileMapper files,ObjectMapper json) { this.projects=projects; this.storage=storage; this.files=files; this.json=json; }
    @Transactional
    public UUID active(UUID project) {
        if (projects.lock(project)==null) throw new ApiException(ErrorCode.PROJECT_NOT_FOUND);
        UUID id=files.activeStorage(project); if (id==null) throw new ApiException(ErrorCode.STORAGE_NOT_FOUND);
        var current=storage.selectById(id);
        if (!current.getAutoFailover() || !exceeded(current)) return id;
        for (var candidate:storage.candidates(project,id)) if (!exceeded(candidate)) {
            projects.deactivate(project); projects.bind(project,candidate.getId(),true);
            files.migrationTask(project,candidate.getId()); return candidate.getId();
        }
        throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
    }
    private boolean exceeded(StorageConfigsEntity value) {
        Long bytes=value.getManualStorageBytes(),traffic=value.getManualTrafficBytes();
        if (value.getLastUsage()!=null) try {
            var usage=json.readTree(value.getLastUsage());
            if (bytes==null && usage.path("usedBytes").isIntegralNumber()) bytes=usage.path("usedBytes").longValue();
            if (traffic==null && usage.path("trafficBytes").isIntegralNumber()) traffic=usage.path("trafficBytes").longValue();
        } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        return reached(bytes,value.getStorageQuotaBytes(),value.getFailoverThresholdPct()) || reached(traffic,value.getTrafficQuotaBytes(),value.getFailoverThresholdPct());
    }
    private boolean reached(Long used,Long quota,int threshold) {
        return used!=null && quota!=null && quota>0 && BigInteger.valueOf(used).multiply(BigInteger.valueOf(100)).compareTo(BigInteger.valueOf(quota).multiply(BigInteger.valueOf(threshold)))>=0;
    }
}
