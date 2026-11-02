package com.ufm.storage;

import com.ufm.common.error.*;
import java.net.*;

public final class SafeEndpoint {
    private SafeEndpoint() {}
    public static URI validate(String value,boolean allowPrivate) {
        try {
            URI uri=URI.create(value);
            if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost()==null
                    || uri.getUserInfo()!=null || uri.getFragment()!=null) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            if (!allowPrivate) for (InetAddress address:InetAddress.getAllByName(uri.getHost())) {
                if (!PublicDnsResolver.isPublic(address))
                    throw new ApiException(ErrorCode.FORBIDDEN);
            }
            return uri;
        } catch (UnknownHostException | IllegalArgumentException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }
}
