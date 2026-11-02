package com.ufm.open;

import com.ufm.common.crypto.SecretCipher;
import com.ufm.common.error.*;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.*;
import org.apache.ibatis.annotations.*;
import org.springframework.stereotype.Service;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.time.Instant;
import java.util.*;

@Service
public class OpenApiAuthentication {
    public record Principal(UUID projectId) {}
    public record Credential(UUID projectId,String encrypted) {}
    @Mapper public interface Queries {
        @Select("SELECT p.id AS project_id,s.secret_enc AS encrypted FROM projects p JOIN project_secrets s ON s.project_id=p.id WHERE p.app_id=#{app} AND p.deleted_at IS NULL AND s.name='primary' AND s.enabled AND s.deleted_at IS NULL")
        Credential credential(String app);
        @Insert("INSERT INTO nonces(app_id,nonce,expires_at) VALUES(#{app},#{nonce},now()+interval '10 minutes') ON CONFLICT(app_id,nonce) DO NOTHING")
        int nonce(String app,String nonce);
    }
    public static final class AuthenticatedBody extends HttpServletRequestWrapper implements AutoCloseable {
        private final Path path;
        private final Principal principal;
        private InputStream stream;
        AuthenticatedBody(HttpServletRequest request,Path path,Principal principal) { super(request); this.path=path; this.principal=principal; }
        public Principal principal() { return principal; }
        public Path path() { return path; }
        @Override public ServletInputStream getInputStream() throws IOException {
            stream=Files.newInputStream(path); InputStream input=stream;
            return new ServletInputStream() {
                private boolean finished;
                @Override public int read() throws IOException { int value=input.read(); finished=value<0; return value; }
                @Override public int read(byte[] b,int off,int len) throws IOException { int n=input.read(b,off,len); finished=n<0; return n; }
                @Override public void close() throws IOException { input.close(); }
                @Override public boolean isFinished() { return finished; }
                @Override public boolean isReady() { return true; }
                @Override public void setReadListener(ReadListener listener) { throw new UnsupportedOperationException("Synchronous request body only"); }
            };
        }
        @Override public BufferedReader getReader() throws IOException { return new BufferedReader(new InputStreamReader(getInputStream(),StandardCharsets.UTF_8)); }
        @Override public void close() throws IOException { if (stream!=null) stream.close(); Files.deleteIfExists(path); }
    }
    private final Queries queries;
    private final SecretCipher cipher;
    public OpenApiAuthentication(Queries queries,SecretCipher cipher) { this.queries=queries; this.cipher=cipher; }
    public AuthenticatedBody authenticate(HttpServletRequest request) throws IOException {
        String app=header(request,"X-App-Id",64),timestamp=header(request,"X-Timestamp",16),nonce=header(request,"X-Nonce",128),
                hash=header(request,"X-Content-SHA256",64),signature=header(request,"X-Signature",64);
        if (!app.matches("[a-zA-Z0-9_-]{16,64}") || !nonce.matches("[a-zA-Z0-9_-]{16,128}") || !hash.matches("[0-9a-f]{64}") || !signature.matches("[0-9a-f]{64}")) reject();
        try { long time=Long.parseLong(timestamp),now=Instant.now().getEpochSecond(); if (time<now-300 || time>now+300) reject(); }
        catch (NumberFormatException ex) { reject(); }
        Credential credential=queries.credential(app); if (credential==null) throw new ApiException(ErrorCode.UNAUTHORIZED);
        String range=optionalHeader(request,"Range",128);
        String canonical=request.getMethod()+"\n"+request.getRequestURI()+"\n"+Objects.toString(request.getQueryString(),"")+"\n"+timestamp+"\n"+nonce+"\n"+hash+"\n"+range;
        try {
            Mac mac=Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(cipher.decrypt(credential.encrypted()).getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
            if (!MessageDigest.isEqual(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)),HexFormat.of().parseHex(signature))) reject();
        } catch (GeneralSecurityException ex) { throw new IllegalStateException(ex); }
        Path temp=Files.createTempFile("ufm-open-",".body"); boolean accepted=false;
        try {
            MessageDigest digest;
            try { digest=MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
            try (var in=request.getInputStream(); var out=Files.newOutputStream(temp)) {
                byte[] buffer=new byte[65536]; long size=0; int n;
                while ((n=in.read(buffer))!=-1) { size+=n; if (size>com.ufm.common.config.UploadLimits.MAX_FILE_BYTES) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE); digest.update(buffer,0,n); out.write(buffer,0,n); }
            }
            if (!MessageDigest.isEqual(digest.digest(),HexFormat.of().parseHex(hash))) reject();
            if (queries.nonce(app,nonce)!=1) reject();
            var wrapped=new AuthenticatedBody(request,temp,new Principal(credential.projectId())); accepted=true; return wrapped;
        } finally { if (!accepted) Files.deleteIfExists(temp); }
    }
    private String header(HttpServletRequest request,String name,int max) {
        String value=optionalHeader(request,name,max); if (value.isEmpty()) reject(); return value;
    }
    private String optionalHeader(HttpServletRequest request,String name,int max) {
        var values=Collections.list(request.getHeaders(name));
        if (values.size()>1 || (!values.isEmpty() && values.getFirst().length()>max)) reject();
        return values.isEmpty()?"":values.getFirst();
    }
    private static void reject() { throw new ApiException(ErrorCode.UNAUTHORIZED); }
}
