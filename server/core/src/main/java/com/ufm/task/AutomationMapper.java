package com.ufm.task;

import org.apache.ibatis.annotations.*;

@Mapper
public interface AutomationMapper {
    @Insert("""
        INSERT INTO settings(key,value) VALUES(#{key},jsonb_build_object('run',extract(epoch FROM now())))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
          WHERE coalesce((settings.value->>'run')::numeric,0)<extract(epoch FROM now())-#{seconds}
        """) int claimWindow(String key,int seconds);
    @Delete("""
        DELETE FROM settings WHERE (key LIKE 'auth.rate.%' OR key LIKE 'share.password.%' OR key LIKE 'share.visit.%' OR key LIKE 'share.media.%')
          AND (value->>'expires')::numeric<extract(epoch FROM now())
        """) int rates();
    @Delete("DELETE FROM nonces WHERE expires_at<now()") int nonces();
    @Delete("DELETE FROM upload_credentials WHERE expires_at<now()-interval '1 day'") int credentials();
    @Insert("""
        INSERT INTO settings(key,value) VALUES(#{key},jsonb_build_object('day',#{day}))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value->>'day' IS DISTINCT FROM #{day}
        """) int claimDay(String key,String day);
}
