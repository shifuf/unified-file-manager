package com.ufm.share;

import com.ufm.common.error.*;
import com.ufm.project.ProjectService;
import org.apache.ibatis.annotations.*;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;
import java.time.*;
import java.util.*;

@RestController
public class DownloadStatistics {
    @io.swagger.v3.oas.annotations.media.Schema(name="DownloadRecord")
    public record Record(UUID id,UUID fileId,String source,String ip,String userAgent,String referer,Long rangeStart,Long rangeEnd,long bytesSent,boolean success,String failureReason,OffsetDateTime createdAt) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DownloadRecordPage")
    public record Page(List<Record> items,long total) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DownloadTop")
    public record Top(UUID fileId,String name,long downloads,long bytes) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="AccessDaily")
    public record Access(LocalDate day,UUID fileId,String refererHost,long accessCount) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="IpLedger")
    public record Ip(String ip,long downloadCount,long rateLimitCount,UUID lastFileId,OffsetDateTime lastAccessAt) {}
    @Mapper
    public interface Queries {
        String WHERE=" FROM download_records WHERE project_id=#{project} AND (CAST(#{source} AS text) IS NULL OR source=#{source}) AND (CAST(#{success} AS boolean) IS NULL OR success=#{success})";
        @Select("SELECT id,file_id,source,host(ip) AS ip,user_agent,referer,range_start,range_end,bytes_sent,success,failure_reason,created_at"+WHERE+" ORDER BY created_at DESC,id LIMIT #{size} OFFSET #{offset}")
        List<Record> records(UUID project,String source,Boolean success,int size,long offset);
        @Select("SELECT count(*)"+WHERE) long count(UUID project,String source,Boolean success);
        @Select("SELECT s.file_id,f.original_name AS name,sum(s.download_count) AS downloads,sum(s.bytes_sent) AS bytes FROM download_daily_stats s LEFT JOIN files f ON f.id=s.file_id WHERE s.project_id=#{project} GROUP BY s.file_id,f.original_name ORDER BY sum(s.download_count) DESC,s.file_id LIMIT 20")
        List<Top> top(UUID project);
        @Select("SELECT day,file_id,referer_host,access_count FROM access_daily_stats WHERE project_id=#{project} ORDER BY day DESC,access_count DESC LIMIT 365")
        List<Access> access(UUID project);
        @Select("SELECT host(ip) AS ip,download_count,rate_limit_count,last_file_id,last_access_at FROM share_ip_stats ORDER BY last_access_at DESC LIMIT 500")
        List<Ip> ips();
    }
    private final Queries queries;
    private final ProjectService projects;
    public DownloadStatistics(Queries queries,ProjectService projects) { this.queries=queries; this.projects=projects; }
    @GetMapping("/api/download-stats/list")
    public Page records(@RequestParam UUID projectId,@RequestParam(required=false) String source,@RequestParam(required=false) Boolean success,
                        @RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="50") int size) {
        projects.require(projectId);
        if (page<0 || size<1 || size>200 || source!=null && !List.of("ADMIN","OPEN_API","PUBLIC","SHARE","FOLDER_SHARE","WEBDAV","BATCH").contains(source)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return new Page(queries.records(projectId,source,success,size,(long)page*size),queries.count(projectId,source,success));
    }
    @GetMapping("/api/download-stats/top")
    public Map<String,Object> top(@RequestParam UUID projectId) { projects.require(projectId); return Map.of("items",queries.top(projectId)); }
    @GetMapping("/api/download-stats/access")
    public Map<String,Object> access(@RequestParam UUID projectId) { projects.require(projectId); return Map.of("items",queries.access(projectId)); }
    @GetMapping("/api/ip-stats/ledger")
    public Map<String,Object> ips() { return Map.of("items",queries.ips()); }
}
