package com.ufm.notify;

import org.apache.ibatis.annotations.*;
import java.time.OffsetDateTime;
import java.util.*;

@Mapper
public interface NotificationMapper {
    record View(UUID id,String title,String body,String level,String href,OffsetDateTime readAt,OffsetDateTime createdAt) {}
    @Insert("INSERT INTO notifications(user_id,project_id,title,body,href) SELECT id,#{project},#{title},#{body},#{href} FROM users WHERE enabled AND deleted_at IS NULL")
    int emit(UUID project,String title,String body,String href);
    @Select("SELECT id FROM notifications WHERE project_id IS NOT DISTINCT FROM #{project} AND title=#{title} AND href=#{href} AND read_at IS NULL AND deleted_at IS NULL AND created_at>now()-interval '30 seconds' ORDER BY created_at DESC LIMIT 1 FOR UPDATE")
    UUID recent(UUID project,String title,String href);
    @Update("UPDATE notifications SET body=#{body} WHERE id=#{id}") int aggregate(UUID id,String body);
    @Select("SELECT id,title,body,level,href,read_at,created_at FROM notifications WHERE user_id=#{user} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200") List<View> list(UUID user);
    @Select("SELECT count(*) FROM notifications WHERE user_id=#{user} AND read_at IS NULL AND deleted_at IS NULL") long unread(UUID user);
    @Update("UPDATE notifications SET read_at=now() WHERE user_id=#{user} AND id=#{id}") int read(UUID user,UUID id);
    @Update("UPDATE notifications SET read_at=now() WHERE user_id=#{user} AND read_at IS NULL") int readAll(UUID user);
}
