package com.ufm.file;

import org.springframework.web.multipart.MultipartFile;
import java.io.*;
import java.nio.file.*;

public final class PathUpload implements MultipartFile {
    private final Path path;
    private final String name;
    public PathUpload(Path path,String name) { this.path=path; this.name=name; }
    public String getName() { return "file"; }
    public String getOriginalFilename() { return name; }
    public String getContentType() { return "application/octet-stream"; }
    public boolean isEmpty() { return getSize()==0; }
    public long getSize() { try { return Files.size(path); } catch (IOException ex) { throw new UncheckedIOException(ex); } }
    public byte[] getBytes() throws IOException { throw new IOException("Streaming upload must not be buffered"); }
    public InputStream getInputStream() throws IOException { return Files.newInputStream(path); }
    public void transferTo(File target) throws IOException { Files.copy(path,target.toPath()); }
}
