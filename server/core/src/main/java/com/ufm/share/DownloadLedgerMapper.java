package com.ufm.share;

import org.apache.ibatis.annotations.*;
import java.util.*;

@Mapper
public interface DownloadLedgerMapper {
    @Insert("INSERT INTO access_daily_stats(day,project_id,file_id,referer_host,access_count) VALUES(current_date,#{project},#{file},#{host},1) ON CONFLICT(day,project_id,file_id,referer_host) DO UPDATE SET access_count=access_daily_stats.access_count+1")
    int access(UUID project,UUID file,String host);
    @Insert("INSERT INTO download_records(id,project_id,file_id,source,ip,user_agent,referer,bytes_sent,success) VALUES(#{id},#{project},#{file},#{source},CAST(#{ip} AS inet),#{ua},#{referer},0,false)")
    int start(UUID id,UUID project,UUID file,String source,String ip,String ua,String referer);
    @Update("UPDATE download_records SET range_start=#{start},range_end=#{end} WHERE id=#{id}")
    int range(UUID id,long start,long end);
    @Update("UPDATE download_records SET bytes_sent=#{bytes},success=#{success},failure_reason=#{reason} WHERE id=#{id}")
    int finish(UUID id,long bytes,boolean success,String reason);
    @Select("SELECT EXISTS(SELECT 1 FROM ip_bans WHERE ip=CAST(#{ip} AS inet) AND (permanent OR until>now()))")
    boolean banned(String ip);
    @Insert("INSERT INTO ip_bans(ip,permanent,until,reason) VALUES(CAST(#{ip} AS inet),#{permanent},#{until},#{reason}) ON CONFLICT(ip) DO UPDATE SET permanent=excluded.permanent,until=excluded.until,reason=excluded.reason") int ban(ShareDtos.Ban input);
    @Delete("DELETE FROM ip_bans WHERE ip=CAST(#{ip} AS inet)") int unban(String ip);
    @Select("SELECT ip::text,permanent,until,reason FROM ip_bans ORDER BY created_at DESC LIMIT 500") List<Map<String,Object>> bans();
    @Select("SELECT count(*) FROM download_records WHERE ip=CAST(#{ip} AS inet) AND file_id=#{file} AND created_at>now()-interval '10 minutes'") long recent(String ip,UUID file);
    @Insert("""
        INSERT INTO download_records(project_id,file_id,source,ip,user_agent,referer,bytes_sent,success)
        VALUES(#{project},#{file},#{source},CAST(#{ip} AS inet),#{ua},#{referer},#{bytes},true)
        """) int record(UUID project,UUID file,String source,String ip,String ua,String referer,long bytes);
    @Insert("""
        INSERT INTO download_daily_stats(day,project_id,file_id,source,download_count,bytes_sent)
        VALUES(current_date,#{project},#{file},#{source},1,#{bytes})
        ON CONFLICT(day,project_id,file_id,source) DO UPDATE SET download_count=download_daily_stats.download_count+1,bytes_sent=download_daily_stats.bytes_sent+excluded.bytes_sent
        """) int daily(UUID project,UUID file,String source,long bytes);
    @Select("SELECT coalesce(sum(download_count),0) AS downloads,coalesce(sum(bytes_sent),0) AS bytes FROM download_daily_stats WHERE project_id=#{project}")
    Map<String,Object> summary(UUID project);
    @Insert("""
        INSERT INTO share_ip_stats(ip,download_count,last_file_id,last_access_at) VALUES(CAST(#{ip} AS inet),1,#{file},now())
        ON CONFLICT(ip) DO UPDATE SET download_count=share_ip_stats.download_count+1,last_file_id=excluded.last_file_id,last_access_at=now()
        """) int ipDownload(String ip,UUID file);
    @Insert("""
        INSERT INTO share_ip_stats(ip,rate_limit_count,last_file_id,last_access_at) VALUES(CAST(#{ip} AS inet),1,#{file},now())
        ON CONFLICT(ip) DO UPDATE SET rate_limit_count=share_ip_stats.rate_limit_count+1,last_file_id=excluded.last_file_id,last_access_at=now()
        """) int ipLimited(String ip,UUID file);
    @Select("SELECT day,source,download_count,bytes_sent FROM download_daily_stats WHERE project_id=#{project} ORDER BY day DESC LIMIT 365") List<Map<String,Object>> dailyStats(UUID project);
}
