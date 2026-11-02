package com.ufm.share;

import com.ufm.common.error.*;
import java.net.InetAddress;
import java.util.List;

final class IpPolicy {
    private IpPolicy() {}
    static void validate(List<String> rules) {
        if (rules==null) return;
        for (String rule:rules) parse(rule);
    }
    static boolean allows(List<String> rules,String address) {
        if (rules.isEmpty()) return true;
        byte[] candidate=literal(address);
        for (String rule:rules) {
            Network network=parse(rule); byte[] base=network.address();
            if (candidate.length!=base.length) continue;
            boolean matches=true;
            for (int bit=0;bit<network.bits();bit++)
                if (((candidate[bit/8]^base[bit/8]) & (1<<(7-bit%8)))!=0) { matches=false; break; }
            if (matches) return true;
        }
        return false;
    }
    private record Network(byte[] address,int bits) {}
    private static Network parse(String value) {
        try {
            String[] parts=value.split("/",-1); if (parts.length>2) throw new IllegalArgumentException();
            byte[] address=literal(parts[0]); int bits=parts.length==1?address.length*8:Integer.parseInt(parts[1]);
            if (bits<0 || bits>address.length*8) throw new IllegalArgumentException();
            return new Network(address,bits);
        } catch (RuntimeException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }
    private static byte[] literal(String value) {
        try {
            if (value==null || !value.matches("[0-9a-fA-F:.]{2,64}")) throw new IllegalArgumentException();
            if (!value.contains(":")) {
                String[] parts=value.split("\\.",-1); if (parts.length!=4) throw new IllegalArgumentException();
                for (String part:parts) if (part.isEmpty() || Integer.parseInt(part)>255) throw new IllegalArgumentException();
            }
            return InetAddress.getByName(value).getAddress();
        } catch (Exception ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }
}
