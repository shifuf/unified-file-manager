package com.ufm.auth;

import com.ufm.common.error.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class LoginRateLimiter {
    private final LoginRateMapper mapper;
    public LoginRateLimiter(LoginRateMapper mapper) { this.mapper=mapper; }

    @Transactional(propagation=Propagation.REQUIRES_NEW,noRollbackFor=ApiException.class)
    public void check(String username,String ip) {
        int address=mapper.increment("auth.rate.ip."+AuthService.hash(ip),300);
        int account=mapper.increment("auth.rate.account."+AuthService.hash(username.toLowerCase(java.util.Locale.ROOT)),900);
        if (address>10 || account>5) throw new ApiException(ErrorCode.RATE_LIMITED);
    }
}
