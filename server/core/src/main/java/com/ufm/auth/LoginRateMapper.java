package com.ufm.auth;

import org.apache.ibatis.annotations.*;

@Mapper
public interface LoginRateMapper {
    @Select(value="""
        INSERT INTO settings(key,value) VALUES(#{key},jsonb_build_object('count',1,'expires',extract(epoch FROM now())+#{seconds}))
        ON CONFLICT(key) DO UPDATE SET value=CASE
          WHEN (settings.value->>'expires')::numeric < extract(epoch FROM now())
          THEN excluded.value
          ELSE jsonb_set(settings.value,'{count}',to_jsonb((settings.value->>'count')::integer+1)) END
        RETURNING (value->>'count')::integer
        """,affectData=true)
    @org.apache.ibatis.annotations.Options(flushCache=org.apache.ibatis.annotations.Options.FlushCachePolicy.TRUE)
    int increment(String key,int seconds);
}
