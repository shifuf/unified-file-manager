package com.ufm.share;

import com.ufm.generated.entity.FilesEntity;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;
import java.util.UUID;

@Service
public class TransferAccounting {
    public static final String ATTRIBUTE="ufm.transfer";
    public record Transfer(UUID id,UUID project,UUID file,String source,boolean redirected) {}
    private final DownloadLedgerMapper mapper;
    public TransferAccounting(DownloadLedgerMapper mapper) { this.mapper=mapper; }
    public void start(FilesEntity file,String source,boolean redirected,HttpServletRequest request) {
        UUID id=UUID.randomUUID();
        mapper.start(id,file.getProjectId(),file.getId(),source,request.getRemoteAddr(),bounded(request.getHeader("User-Agent")),bounded(request.getHeader("Referer")));
        String range=request.getHeader("Range");
        if (range!=null) try { var parsed=com.ufm.file.ByteRange.parse(range,file.getSize()); mapper.range(id,parsed.start(),parsed.end()); }
        catch (IllegalArgumentException ignored) { /* Invalid ranges are rejected by the download controller. */ }
        request.setAttribute(ATTRIBUTE,new Transfer(id,file.getProjectId(),file.getId(),source,redirected));
    }
    @Transactional(propagation=Propagation.REQUIRES_NEW)
    public void finish(Transfer transfer,long bytes,int status,boolean failed) {
        boolean success=!failed && status>=200 && status<300;
        if (transfer.redirected()) { bytes=0; success=false; }
        mapper.finish(transfer.id(),bytes,success,transfer.redirected()?"Redirect issued; remote transfer completion is not observable":success?null:"Transfer interrupted or rejected");
        if (success) mapper.daily(transfer.project(),transfer.file(),transfer.source(),bytes);
    }
    private String bounded(String value) { return value==null?null:value.substring(0,Math.min(2048,value.length())); }
}
