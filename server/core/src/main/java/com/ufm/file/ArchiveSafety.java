package com.ufm.file;

import com.ufm.common.error.*;
import java.io.*;
import java.nio.file.*;
import java.util.zip.*;

public final class ArchiveSafety {
    private ArchiveSafety() {}
    public static void check(Path path,int maxEntries,long maxBytes) {
        try (ZipInputStream input=new ZipInputStream(Files.newInputStream(path))) {
            long total=0; int count=0; ZipEntry entry; byte[] buffer=new byte[65536];
            while ((entry=input.getNextEntry())!=null) {
                if (++count>maxEntries) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
                String name=entry.getName();
                if (name.startsWith("/") || name.contains("\\") || name.contains(":") || name.contains("\u0000"))
                    throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                for (String part:name.split("/")) if (part.equals("..") || part.equals(".")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                int read;
                while ((read=input.read(buffer))!=-1) {
                    total+=read; if (total>maxBytes) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
                }
                input.closeEntry();
            }
        } catch (IOException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }
}
