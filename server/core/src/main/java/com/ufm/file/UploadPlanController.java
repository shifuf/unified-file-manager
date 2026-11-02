package com.ufm.file;

import com.ufm.common.error.*;
import com.ufm.project.ProjectService;
import com.ufm.storage.StorageService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
import java.util.UUID;

@RestController
public class UploadPlanController {
    private static final int CHUNK=com.ufm.common.config.UploadLimits.CHUNK_SIZE;
    private final FileMapper mapper;
    private final StorageService storage;
    private final ProjectService projects;
    private final UploadService chunks;
    private final DirectUploadService direct;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.storage.StorageSelection selection;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.common.config.GlobalSettings global;
    public UploadPlanController(FileMapper mapper,StorageService storage,ProjectService projects,UploadService chunks,DirectUploadService direct) {
        this.mapper=mapper; this.storage=storage; this.projects=projects; this.chunks=chunks; this.direct=direct;
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="UploadPlan")
    public record Plan(String channel,UUID id,String url,int chunkSize,int partCount,
                       String uploadUrl,Map<String,String> fields,long expiresIn) {}
    @PostMapping("/api/uploads/plan") @ResponseStatus(HttpStatus.CREATED)
    public Plan plan(@Valid @RequestBody DirectUploadService.Input input) {
        global.uploadSize(input.size());
        chunks.preflight(input);
        UUID id=selection.active(input.projectId());
        if (id==null) throw new ApiException(ErrorCode.STORAGE_NOT_FOUND);
        String provider=storage.requireEnabled(id).getProvider();
        if (provider.equals("QINIU") || provider.equals("UPYUN")) {
            if (input.size()<=com.ufm.common.config.UploadLimits.FORM_DIRECT_MAX_BYTES) {
                var form=direct.form(input);
                return new Plan(form.channel(),form.id(),null,CHUNK,1,form.uploadUrl(),form.fields(),form.expiresIn());
            }
            if (input.size()<=com.ufm.common.config.UploadLimits.MAX_FILE_BYTES) {
                var state=chunks.init(new UploadService.Init(input.projectId(),input.originalName(),input.folderPath(),input.size(),CHUNK));
                return new Plan("CHUNK",state.id(),null,CHUNK,
                        (int)((input.size()+CHUNK-1)/CHUNK),null,Map.of(),0);
            }
        }
        if (provider.equals("LOCAL")) {
            if (input.size()<=CHUNK) return new Plan("RELAY",null,null,CHUNK,1,null,Map.of(),0);
            var state=chunks.init(new UploadService.Init(input.projectId(),input.originalName(),input.folderPath(),input.size(),CHUNK));
            return new Plan("CHUNK",state.id(),null,CHUNK,(int)((input.size()+CHUNK-1)/CHUNK),null,Map.of(),0);
        }
        if (input.size()<=CHUNK) {
            var signed=direct.presign(input);
            return new Plan("PRESIGNED",signed.id(),signed.url(),CHUNK,1,null,Map.of(),0);
        }
        var multipart=direct.multipart(input);
        return new Plan("MULTIPART",multipart.id(),null,multipart.partSize(),multipart.partCount(),null,Map.of(),0);
    }
}
