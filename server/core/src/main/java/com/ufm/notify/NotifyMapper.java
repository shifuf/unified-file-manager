package com.ufm.notify;

import org.apache.ibatis.annotations.*;
import java.time.OffsetDateTime;
import java.util.*;

@Mapper
public interface NotifyMapper {
    record Channel(UUID id,UUID projectId,String name,String type,String config,String events,boolean enabled) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="NotifyDelivery")
    record Delivery(UUID id,String event,boolean success,Integer statusCode,String error,OffsetDateTime createdAt) {}
    @Insert("INSERT INTO notify_channels(id,project_id,name,type,config,events,enabled) VALUES(#{id},#{project},#{name},#{type},CAST(#{config} AS jsonb),CAST(#{events} AS jsonb),#{enabled})")
    int create(UUID id,UUID project,String name,String type,String config,String events,boolean enabled);
    @Select("SELECT id,project_id,name,type,config::text,events::text,enabled FROM notify_channels WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200") List<Channel> channels();
    @Select("SELECT id,project_id,name,type,config::text,events::text,enabled FROM notify_channels WHERE id=#{id} AND deleted_at IS NULL") Channel get(UUID id);
    @Update("UPDATE notify_channels SET deleted_at=now(),enabled=false WHERE id=#{id}") int delete(UUID id);
    @Update("UPDATE notify_channels SET name=#{name},config=CAST(#{config} AS jsonb),events=CAST(#{events} AS jsonb),enabled=#{enabled} WHERE id=#{id} AND deleted_at IS NULL")
    int edit(UUID id,String name,String config,String events,boolean enabled);
    @Insert("INSERT INTO notify_deliveries(channel_id,event,success,status_code,error) VALUES(#{id},#{event},#{success},#{status},#{error})")
    int delivery(UUID id,String event,boolean success,Integer status,String error);
    @Select("SELECT id,event,success,status_code,error,created_at FROM notify_deliveries WHERE channel_id=#{id} ORDER BY created_at DESC LIMIT 100") List<Delivery> deliveries(UUID id);
    @Update("SELECT pg_advisory_xact_lock(hashtextextended(#{scope},0))") void aggregateLock(String scope);
    @Select("SELECT id FROM tasks WHERE type='NOTIFY' AND status='PENDING' AND attempts=0 AND run_at>now() AND payload->>'channelId'=#{channel} AND payload->>'event'=#{event} AND payload->>'aggregateProject'=#{project} ORDER BY created_at DESC LIMIT 1 FOR UPDATE")
    UUID aggregatePending(String channel,String event,String project);
    @Update("""
        UPDATE tasks SET payload=jsonb_set(payload,'{data,aggregation}',jsonb_build_object(
          'count',COALESCE((payload#>>'{data,aggregation,count}')::bigint,1)+1,
          'samples',CASE WHEN jsonb_array_length(payload#>'{data,aggregation,samples}')<10
             THEN (payload#>'{data,aggregation,samples}')||jsonb_build_array(CAST(#{sample} AS jsonb))
             ELSE payload#>'{data,aggregation,samples}' END)) WHERE id=#{id} AND status='PENDING' AND attempts=0
        """) int aggregate(UUID id,String sample);
    @Insert("INSERT INTO tasks(type,payload,run_at) VALUES('NOTIFY',CAST(#{payload} AS jsonb),now()+interval '30 seconds')")
    int aggregateCreate(String payload);
}
