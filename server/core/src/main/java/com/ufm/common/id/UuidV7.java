package com.ufm.common.id;

import java.math.BigInteger;
import java.security.SecureRandom;
import java.util.UUID;

/**
 * Thread-safe UUIDv7 generator with monotonic ordering within a millisecond.
 */
public final class UuidV7 {

    private static final BigInteger RANDOM_BITS = BigInteger.ONE.shiftLeft(74);
    private static final BigInteger RANDOM_MASK = RANDOM_BITS.subtract(BigInteger.ONE);
    private static final long TIMESTAMP_MASK = (1L << 48) - 1;
    private static final long RANDOM_B_MASK = (1L << 62) - 1;
    private static final SecureRandom RANDOM = new SecureRandom();

    private static long lastTimestamp = -1L;
    private static BigInteger lastRandom = BigInteger.ZERO;

    private UuidV7() {
    }

    public static synchronized UUID generate() {
        long now = System.currentTimeMillis();
        if (now > lastTimestamp) {
            lastTimestamp = now;
            lastRandom = new BigInteger(74, RANDOM);
        } else {
            lastRandom = lastRandom.add(BigInteger.ONE).and(RANDOM_MASK);
            if (lastRandom.equals(BigInteger.ZERO)) {
                lastTimestamp++;
            }
        }

        long mostSignificant = ((lastTimestamp & TIMESTAMP_MASK) << 16)
                | 0x7000L
                | lastRandom.shiftRight(62).longValue();
        long leastSignificant = lastRandom.longValue() & RANDOM_B_MASK;
        leastSignificant = (leastSignificant & 0x3FFF_FFFF_FFFF_FFFFL) | 0x8000_0000_0000_0000L;
        return new UUID(mostSignificant, leastSignificant);
    }
}
