package com.ufm.share;

import com.ufm.auth.AuthService;
import com.ufm.auth.LoginRateMapper;
import com.ufm.common.error.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;
import java.util.UUID;

@Service
public class ShareRateLimiter {
    private final LoginRateMapper mapper;
    public ShareRateLimiter(LoginRateMapper mapper) { this.mapper=mapper; }
    @Transactional(propagation=Propagation.REQUIRES_NEW,noRollbackFor=ApiException.class)
    public void password(UUID share,String ip) {
        if (mapper.increment("share.password."+share+"."+AuthService.hash(ip),600)>5)
            throw new ApiException(ErrorCode.RATE_LIMITED);
    }
    @Transactional(propagation=Propagation.REQUIRES_NEW,noRollbackFor=ApiException.class)
    public void visit(UUID share,String ip) {
        if (mapper.increment("share.visit."+share+"."+AuthService.hash(ip),600)>120)
            throw new ApiException(ErrorCode.RATE_LIMITED);
    }
    @Transactional(propagation=Propagation.REQUIRES_NEW,noRollbackFor=ApiException.class)
    public void media(UUID share,String ip) {
        if (mapper.increment("share.media."+share+"."+AuthService.hash(ip),600)>12000)
            throw new ApiException(ErrorCode.RATE_LIMITED);
    }
}
