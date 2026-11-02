package com.ufm.auth.jwt;

public class JwtAuthenticationException extends RuntimeException {

    public enum Reason {
        EXPIRED,
        INVALID
    }

    private final Reason reason;

    public JwtAuthenticationException(Reason reason, String message, Throwable cause) {
        super(message, cause);
        this.reason = reason;
    }

    public Reason getReason() {
        return reason;
    }
}
