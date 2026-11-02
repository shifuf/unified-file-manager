package com.ufm.common.crypto;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * AES-256-GCM encryption for provider credentials, TOTP seeds and project secrets.
 */
public final class SecretCipher {

    private static final String PREFIX = "v2";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final byte[] AAD = "ufm-secret-v2".getBytes(StandardCharsets.US_ASCII);

    private final SecretKeySpec key;
    private final SecureRandom random = new SecureRandom();

    public SecretCipher(String base64Key) {
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(base64Key);
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("UFM_CRYPTO_KEY must be base64 encoded", ex);
        }
        if (decoded.length != 32) {
            throw new IllegalArgumentException("UFM_CRYPTO_KEY must decode to 32 bytes");
        }
        this.key = new SecretKeySpec(decoded, "AES");
    }

    public String encrypt(String plaintext) {
        try {
            byte[] nonce = new byte[NONCE_BYTES];
            random.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(AAD);
            byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            Base64.Encoder encoder = Base64.getUrlEncoder().withoutPadding();
            return PREFIX + ":" + encoder.encodeToString(nonce) + ":" + encoder.encodeToString(encrypted);
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Unable to encrypt secret", ex);
        }
    }

    public String decrypt(String payload) {
        if (payload == null) {
            throw new IllegalArgumentException("Encrypted payload is required");
        }
        String[] parts = payload.split(":", 3);
        if (parts.length != 3 || !PREFIX.equals(parts[0])) {
            throw new IllegalArgumentException("Unsupported encrypted payload");
        }
        try {
            Base64.Decoder decoder = Base64.getUrlDecoder();
            byte[] nonce = decoder.decode(parts[1]);
            byte[] encrypted = decoder.decode(parts[2]);
            if (nonce.length != NONCE_BYTES) {
                throw new IllegalArgumentException("Invalid nonce");
            }
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(AAD);
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException ex) {
            throw new IllegalArgumentException("Encrypted payload is invalid or key does not match", ex);
        }
    }
}
