package com.ufm.audit;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.auth.jwt.JwtClaims;
import com.ufm.open.OpenApiAuthentication;
import jakarta.servlet.http.*;
import org.apache.ibatis.annotations.*;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;
import org.springframework.web.servlet.HandlerMapping;
import java.time.OffsetDateTime;
import java.util.*;

@Service
public class AuditService {
    public record Record(UUID id,String action,UUID actorId,UUID projectId,String ip,String ua,String detail,OffsetDateTime createdAt) {}
    @Mapper public interface Queries {
        @Insert("INSERT INTO audit_logs(action,actor_id,project_id,ip,ua,detail) VALUES(#{action},#{actor},#{project},CAST(#{ip} AS inet),#{ua},CAST(#{detail} AS jsonb))")
        int append(String action,UUID actor,UUID project,String ip,String ua,String detail);
        String FILTER=" FROM audit_logs WHERE (#{action}='' OR action=#{action}) ";
        @Select("SELECT id,action,actor_id,project_id,host(ip) AS ip,ua,detail::text,created_at"+FILTER+"ORDER BY created_at DESC,id DESC LIMIT #{size} OFFSET #{offset}")
        List<Record> list(String action,int size,long offset);
        @Select("SELECT count(*)"+FILTER) long count(String action);
        @Delete("DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at<now()-#{days}*interval '1 day' ORDER BY created_at,id LIMIT 10000)")
        int cleanup(int days);
    }
    private final Queries queries;
    private final ObjectMapper json;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.file.UploadMapper settings;
    public AuditService(Queries queries,ObjectMapper json) { this.queries=queries; this.json=json; }
    @Transactional(propagation=Propagation.REQUIRES_NEW)
    public void append(HttpServletRequest request,HttpServletResponse response) {
        Object pattern=request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        // Store route templates, never token-bearing paths, query strings, bodies or authorization headers.
        String action=request.getMethod()+" "+(pattern==null?"unmapped":pattern.toString());
        var authentication=SecurityContextHolder.getContext().getAuthentication();
        Object principal=authentication==null?null:authentication.getPrincipal();
        UUID actor=principal instanceof JwtClaims claims?claims.userId():null;
        UUID project=principal instanceof OpenApiAuthentication.Principal scoped?scoped.projectId():null;
        String ip=request.getRemoteAddr(),ua=request.getHeader("User-Agent");
        if (ip==null || !ip.matches("[0-9a-fA-F:.]{2,64}")) ip=null;
        if (ua!=null) ua=ua.substring(0,Math.min(2048,ua.length()));
        String detail;
        try { detail=json.writeValueAsString(Map.of("status",response.getStatus(),"requestId",Objects.toString(request.getAttribute(com.ufm.common.error.GlobalExceptionHandler.REQUEST_ID_ATTR),""))); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        queries.append(action,actor,project,ip,ua,detail);
    }
    public List<Record> list(String action,int size,long offset) { return queries.list(action,size,offset); }
    public long count(String action) { return queries.count(action); }
    /** 记录不经过标准请求管线的安全事件（例如第三方预览服务抓取票据）。 */
    @Transactional(propagation=Propagation.REQUIRES_NEW)
    public void record(String action,UUID actor,UUID project,String ip,String ua,String detail) {
        queries.append(action,actor,project,ip,ua,detail);
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="AuditRetention")
    public record Retention(@jakarta.validation.constraints.Min(1) @jakarta.validation.constraints.Max(36500) int days) {}
    public Retention retention() {
        String value=settings.read("audit.retention");
        try { return value==null?new Retention(180):json.readValue(value,Retention.class); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public Retention retention(Retention value) {
        try { settings.save("audit.retention",json.writeValueAsString(value)); return value; }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public int cleanup() { return queries.cleanup(retention().days()); }
}
