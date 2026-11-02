package com.ufm.common.config;

public final class UploadLimits {
    public static final long MAX_FILE_BYTES=5L*1024*1024*1024;
    public static final long FORM_DIRECT_MAX_BYTES=1L*1024*1024*1024;
    public static final int CHUNK_SIZE=5*1024*1024;

    private UploadLimits() {}
}
