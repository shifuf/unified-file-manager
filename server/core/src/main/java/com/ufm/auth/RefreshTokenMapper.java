package com.ufm.auth;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;
import java.util.UUID;

@Mapper
public interface RefreshTokenMapper extends BaseMapper<RefreshTokenEntity> {
    @Select("SELECT * FROM refresh_tokens WHERE token_hash=#{hash} FOR UPDATE")
    RefreshTokenEntity lockToken(String hash);

    @Select("SELECT EXISTS(SELECT 1 FROM refresh_tokens t JOIN users u ON u.id=t.user_id "
            + "WHERE t.id=#{id} AND t.user_id=#{userId} AND t.revoked_at IS NULL "
            + "AND t.expires_at>now() AND t.deleted_at IS NULL AND u.enabled AND u.deleted_at IS NULL)")
    boolean active(UUID id, UUID userId);

    @Update("UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=#{userId} AND revoked_at IS NULL")
    int revokeAll(UUID userId);
}
