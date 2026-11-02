package com.ufm.file;

import com.ufm.common.error.*;
import java.util.Arrays;

public final class FilePaths {
    private FilePaths() {}
    public static String name(String value) {
        if (value==null || value.isBlank() || value.length()>512 || value.equals(".") || value.equals("..")
                || value.matches(".*[\\p{Cntrl}/\\\\:%].*") || value.endsWith(".") || value.endsWith(" "))
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return value;
    }
    public static String folder(String value) {
        if (value==null || value.equals("/")) return "/";
        if (!value.startsWith("/") || value.startsWith("//") || value.length()>2048)
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        String normalized=value.endsWith("/")?value:value+"/";
        String[] segments=normalized.substring(1,normalized.length()-1).split("/",-1);
        Arrays.stream(segments).forEach(FilePaths::name);
        return normalized;
    }
}
