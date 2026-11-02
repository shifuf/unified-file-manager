package com.ufm.common.config;

import org.apache.ibatis.annotations.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;
import java.time.Instant;
import java.util.*;

@RestController
public class SystemStatusController {
    @io.swagger.v3.oas.annotations.media.Schema(name="SystemStorageHealth")
    public record Storage(UUID id,String name,String provider,String status,String checkedAt) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="SystemQueueHealth")
    public record Queue(long pending,long running,long failed,long paused,long expiredLeases) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="SystemStatus")
    public record Status(String version,String database,String time,Queue queue,List<Storage> storages) {}
    @Mapper
    public interface Queries {
        @Select("SELECT 1") int ping();
        @Select("""
            SELECT id,name,provider,
              CASE WHEN NOT enabled THEN 'DISABLED'
                   WHEN last_health->>'success'='true' THEN 'UP'
                   WHEN last_health->>'success'='false' THEN 'DOWN' ELSE 'UNKNOWN' END AS status,
              left(last_health->>'checkedAt',64) AS checked_at
              FROM storage_configs WHERE deleted_at IS NULL ORDER BY priority,id LIMIT 500
            """) List<Storage> storages();
        @Select("""
            SELECT count(*) FILTER(WHERE status='PENDING') AS pending,
              count(*) FILTER(WHERE status='RUNNING') AS running,
              count(*) FILTER(WHERE status='FAILED') AS failed,
              count(*) FILTER(WHERE status='PAUSED') AS paused,
              count(*) FILTER(WHERE status='RUNNING' AND locked_until<now()) AS expired_leases
              FROM tasks WHERE deleted_at IS NULL
            """) Queue queue();
    }
    private final Queries queries;
    private final String version;
    public SystemStatusController(Queries queries,@Value("${ufm.version:0.0.0}") String version) { this.queries=queries; this.version=version; }
    @GetMapping("/api/system/status")
    public Status status() {
        String database;
        try { database=queries.ping()==1?"UP":"DOWN"; }
        catch (org.springframework.dao.DataAccessException ex) { return new Status(version,"DOWN",Instant.now().toString(),null,List.of()); }
        return new Status(version,database,Instant.now().toString(),queries.queue(),queries.storages());
    }
}
