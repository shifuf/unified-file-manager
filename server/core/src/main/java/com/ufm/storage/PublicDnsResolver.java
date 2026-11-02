package com.ufm.storage;

import org.apache.http.conn.DnsResolver;
import java.net.*;

/** Validate the exact answers the transport connects to, not a prior DNS lookup. */
public final class PublicDnsResolver implements DnsResolver {
    private final DnsResolver delegate;
    public PublicDnsResolver() { this(InetAddress::getAllByName); }
    PublicDnsResolver(DnsResolver delegate) { this.delegate=delegate; }
    @Override public InetAddress[] resolve(String host) throws UnknownHostException {
        InetAddress[] addresses=delegate.resolve(host);
        if (addresses.length==0) throw new UnknownHostException("No public destination");
        for (InetAddress address:addresses) if (!isPublic(address)) throw new UnknownHostException("Non-public destination rejected");
        return addresses;
    }
    static boolean isPublic(InetAddress address) {
        if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isSiteLocalAddress()
                || address.isLinkLocalAddress() || address.isMulticastAddress()) return false;
        byte[] b=address.getAddress();
        if (b.length==4) {
            int a=b[0]&255,c=b[1]&255,d=b[2]&255;
            return !(a==0 || a>=224 || a==127 || a==10 || (a==100 && c>=64 && c<=127)
                    || (a==169 && c==254) || (a==172 && c>=16 && c<=31) || (a==192 && (c==168 || c==0 || c==2))
                    || (a==198 && (c==18 || c==19 || (c==51 && d==100))) || (a==203 && c==0 && d==113));
        }
        // Permit only native global-unicast IPv6, excluding documentation and transition ranges.
        return (b[0]&0xe0)==0x20 && !((b[0]&255)==0x20 && (b[1]&255)==0x02)
                && !((b[0]&255)==0x20 && (b[1]&255)==0x01 && ((b[2]&255)==0 || ((b[2]&255)==0x0d && (b[3]&255)==0xb8)));
    }
}
