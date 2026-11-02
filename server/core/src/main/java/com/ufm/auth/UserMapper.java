package com.ufm.auth;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserMapper extends BaseMapper<UserEntity> {
    @org.apache.ibatis.annotations.Update("SELECT pg_advisory_xact_lock(8462417)")
    void lockAdministrator();

    @Select("SELECT * FROM users WHERE username=#{username} AND deleted_at IS NULL FOR UPDATE")
    UserEntity findForLogin(String username);

    @Select("SELECT EXISTS(SELECT 1 FROM settings WHERE key='auth.initialized')")
    boolean bootstrapped();

    @org.apache.ibatis.annotations.Insert("INSERT INTO settings(key,value) VALUES('auth.initialized','true'::jsonb) ON CONFLICT DO NOTHING")
    int markInitialized();
}
