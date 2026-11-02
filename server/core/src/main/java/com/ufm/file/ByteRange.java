package com.ufm.file;

public record ByteRange(long start,long end) {
    public static ByteRange parse(String header,long size) {
        if (size<=0 || header==null || !header.matches("bytes=(\\d*-\\d*)"))
            throw new IllegalArgumentException("Unsatisfiable range");
        try {
            String[] parts=header.substring(6).split("-",-1);
            if (parts[0].isEmpty()) {
                long suffix=Long.parseLong(parts[1]);
                if (suffix<=0) throw new IllegalArgumentException("Invalid suffix");
                return new ByteRange(Math.max(0,size-suffix),size-1);
            }
            long start=Long.parseLong(parts[0]);
            long end=parts[1].isEmpty()?size-1:Math.min(size-1,Long.parseLong(parts[1]));
            if (start>=size || start>end) throw new IllegalArgumentException("Unsatisfiable range");
            return new ByteRange(start,end);
        } catch (NumberFormatException ex) { throw new IllegalArgumentException("Invalid range",ex); }
    }
    public long length() { return end-start+1; }
}
