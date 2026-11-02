package com.ufm.auth.totp;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;

/**
 * RFC 6238 TOTP with the common six-digit / 30-second defaults.
 */
public final class TotpService {

    private static final int TIME_STEP_SECONDS = 30;
    private static final int DIGITS = 6;
    private static final int MODULO = 1_000_000;
    private static final char[] BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    public String generateSecret() {
        byte[] bytes = new byte[20];
        RANDOM.nextBytes(bytes);
        return base32Encode(bytes);
    }

    public String codeAt(String secret, Instant instant) {
        long counter = Math.floorDiv(instant.getEpochSecond(), TIME_STEP_SECONDS);
        return hotp(decodeBase32(secret), counter);
    }

    public boolean verify(String secret, String code, Instant now) {
        if (code == null || !code.matches("\\d{6}")) {
            return false;
        }
        byte[] normalized = code.getBytes(StandardCharsets.US_ASCII);
        for (long offset = -1; offset <= 1; offset++) {
            long counter = Math.floorDiv(now.getEpochSecond(), TIME_STEP_SECONDS) + offset;
            byte[] expected = hotp(decodeBase32(secret), counter).getBytes(StandardCharsets.US_ASCII);
            if (MessageDigest.isEqual(expected, normalized)) {
                return true;
            }
        }
        return false;
    }

    public String otpauthUri(String issuer, String accountName, String secret) {
        String label = urlEncode(issuer + ":" + accountName);
        return "otpauth://totp/" + label
                + "?secret=" + secret
                + "&issuer=" + urlEncode(issuer)
                + "&algorithm=SHA1&digits=" + DIGITS
                + "&period=" + TIME_STEP_SECONDS;
    }

    private String hotp(byte[] key, long counter) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(key, "HmacSHA1"));
            byte[] hash = mac.doFinal(ByteBuffer.allocate(8).putLong(counter).array());
            int offset = hash[hash.length - 1] & 0x0F;
            int binary = ((hash[offset] & 0x7F) << 24)
                    | ((hash[offset + 1] & 0xFF) << 16)
                    | ((hash[offset + 2] & 0xFF) << 8)
                    | (hash[offset + 3] & 0xFF);
            return String.format("%06d", binary % MODULO);
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Unable to calculate TOTP", ex);
        }
    }

    private String base32Encode(byte[] data) {
        StringBuilder result = new StringBuilder((data.length * 8 + 4) / 5);
        int buffer = 0;
        int bitsLeft = 0;
        for (byte value : data) {
            buffer = (buffer << 8) | (value & 0xFF);
            bitsLeft += 8;
            while (bitsLeft >= 5) {
                result.append(BASE32[(buffer >> (bitsLeft - 5)) & 31]);
                bitsLeft -= 5;
            }
        }
        if (bitsLeft > 0) {
            result.append(BASE32[(buffer << (5 - bitsLeft)) & 31]);
        }
        return result.toString();
    }

    private byte[] decodeBase32(String encoded) {
        String normalized = encoded.replace("=", "").replace(" ", "").toUpperCase();
        int buffer = 0;
        int bitsLeft = 0;
        byte[] output = new byte[(normalized.length() * 5) / 8];
        int index = 0;
        for (int i = 0; i < normalized.length(); i++) {
            int value = base32Value(normalized.charAt(i));
            buffer = (buffer << 5) | value;
            bitsLeft += 5;
            if (bitsLeft >= 8) {
                output[index++] = (byte) ((buffer >> (bitsLeft - 8)) & 0xFF);
                bitsLeft -= 8;
            }
        }
        return output;
    }

    private int base32Value(char value) {
        if (value >= 'A' && value <= 'Z') {
            return value - 'A';
        }
        if (value >= '2' && value <= '7') {
            return value - '2' + 26;
        }
        throw new IllegalArgumentException("Invalid base32 secret");
    }

    private String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }
}
