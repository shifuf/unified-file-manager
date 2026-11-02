package com.ufm.task;

import org.apache.ibatis.annotations.*;
import java.util.*;

@Mapper
public interface LifecycleMapper {
    @Select("SELECT value::text FROM settings WHERE key LIKE 'lifecycle.%' ORDER BY key LIMIT 500") List<String> policies();
    @Select("SELECT id FROM files WHERE project_id=#{project} AND starts_with(folder_path,#{folder}) AND (CAST(#{category} AS text) IS NULL OR category=#{category}) AND status='ACTIVE' AND deleted_at IS NULL AND created_at<now()-#{days}*interval '1 day' ORDER BY id LIMIT 50")
    List<UUID> expired(UUID project,String folder,int days,String category);
    @Select("SELECT id FROM files WHERE status='RECYCLED' AND purge_at<now() AND deleted_at IS NULL LIMIT 50") List<UUID> purgeable();
}
