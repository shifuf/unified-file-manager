package com.ufm.file;

import org.apache.ibatis.annotations.*;
import java.time.Instant;
import java.util.UUID;

@Mapper
public interface OfficePreviewMapper {
    @Insert("INSERT INTO office_preview_tickets(file_id,token_hash,expires_at) VALUES(#{file},#{hash},#{expiresAt})")
    int insert(UUID file,String hash,Instant expiresAt);

    /** 单次消费：只有未使用且未过期的票据会更新成功，返回受影响行数由调用方判定。 */
    @Update("UPDATE office_preview_tickets SET used_at=clock_timestamp() WHERE token_hash=#{hash} AND used_at IS NULL AND expires_at>clock_timestamp()")
    int consume(String hash);

    @Select("SELECT file_id FROM office_preview_tickets WHERE token_hash=#{hash}")
    UUID file(String hash);

    @Delete("DELETE FROM office_preview_tickets WHERE expires_at<clock_timestamp()-interval '1 day'")
    int purge();
}
