package com.ufm.task;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.ufm.generated.entity.TasksEntity;
import org.apache.ibatis.annotations.*;
import java.util.*;

@Mapper
public interface TaskMapper extends BaseMapper<TasksEntity> {
    @Select("SELECT * FROM tasks WHERE id=#{id} FOR UPDATE") TasksEntity lock(UUID id);
    @Insert("INSERT INTO tasks(id,project_id,type,payload,idempotency_key) VALUES(#{id},#{project},#{type},CAST(#{payload} AS jsonb),#{key})")
    int enqueue(UUID id,UUID project,String type,String payload,String key);
    @Select(value="SELECT * FROM ufm_claim_task(#{worker},600)",affectData=true)
    @Options(flushCache=Options.FlushCachePolicy.TRUE) TasksEntity claim(String worker);
    @Select(value="SELECT ufm_heartbeat_task(#{id},#{worker},600)",affectData=true)
    @Options(flushCache=Options.FlushCachePolicy.TRUE) boolean heartbeat(UUID id,String worker);
    @Select("SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500") List<TasksEntity> list();
    @Update("UPDATE tasks SET status=#{status},locked_by=NULL,locked_until=NULL,paused_at=CASE WHEN #{status}='PAUSED' THEN now() ELSE NULL END WHERE id=#{id} AND status=#{expected}")
    int transition(UUID id,String expected,String status);
    @Update("UPDATE tasks SET attempts=0,error=NULL,status='PENDING',finished_at=NULL,run_at=now() WHERE id=#{id} AND status IN ('FAILED','CANCELED')") int retry(UUID id);
    @Update("UPDATE tasks SET status='DONE',progress=100,finished_at=now(),locked_by=NULL,locked_until=NULL WHERE id=#{id} AND locked_by=#{worker} AND status='RUNNING'")
    int done(UUID id,String worker);
    @Update("UPDATE tasks SET status=CASE WHEN attempts<max_attempts THEN 'PENDING' ELSE 'FAILED' END,error=#{error},run_at=now()+interval '30 seconds',locked_by=NULL,locked_until=NULL WHERE id=#{id} AND locked_by=#{worker} AND status='RUNNING'")
    int failed(UUID id,String worker,String error);
    @Update("UPDATE tasks SET payload=CAST(#{payload} AS jsonb),progress=#{progress},locked_until=now()+interval '10 minutes' WHERE id=#{id} AND locked_by=#{worker} AND status='RUNNING'")
    int cursor(UUID id,String worker,String payload,int progress);
    @Update("SELECT * FROM ufm_recover_expired_tasks()") void recover();
    @Update("UPDATE tasks SET status='PENDING',locked_by=NULL,locked_until=NULL WHERE locked_by=#{worker} AND status='RUNNING'") int release(String worker);
    String MIGRATABLE=" FROM files f WHERE f.project_id=#{project} AND f.deleted_at IS NULL AND f.status='ACTIVE' AND (f.storage_config_id<>#{target} "
            +"OR EXISTS(SELECT 1 FROM file_versions v WHERE v.file_id=f.id AND v.deleted_at IS NULL AND v.storage_config_id<>#{target}) "
            +"OR EXISTS(SELECT 1 FROM file_derivatives d WHERE d.file_id=f.id AND d.deleted_at IS NULL AND d.storage_config_id<>#{target})) ";
    @Select("SELECT f.id"+MIGRATABLE+"ORDER BY f.id LIMIT 50")
    List<UUID> migrationBatch(UUID project,UUID target);
    @Select("SELECT count(*)"+MIGRATABLE)
    long remaining(UUID project,UUID target);
    @Select("SELECT f.id"+MIGRATABLE+"AND (CAST(#{after} AS uuid) IS NULL OR f.id>#{after}) ORDER BY f.id LIMIT 50")
    List<UUID> migrationAfter(UUID project,UUID target,UUID after);
    @Update("UPDATE tasks SET result=CAST(#{result} AS jsonb),progress=#{progress} WHERE id=#{id} AND locked_by=#{worker} AND status='RUNNING'")
    int migrationResult(UUID id,String worker,String result,int progress);
}
