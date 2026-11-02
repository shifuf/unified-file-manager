package com.ufm.storage;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.error.*;
import org.apache.http.Header;
import org.apache.http.HttpEntity;
import org.apache.http.message.BasicHeader;
import org.apache.http.client.config.RequestConfig;
import org.apache.http.client.methods.*;
import org.apache.http.config.RegistryBuilder;
import org.apache.http.conn.socket.*;
import org.apache.http.conn.ssl.SSLConnectionSocketFactory;
import org.apache.http.entity.ContentType;
import org.apache.http.impl.client.*;
import org.apache.http.impl.conn.PoolingHttpClientConnectionManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.*;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.GeneralSecurityException;
import java.time.Instant;
import java.util.*;

/**
 * 七牛云 Kodo 原生驱动：表单直传协议（putPolicy uptoken）、管理签名（stat/copy/delete）
 * 和私有空间下载 token。
 */
@Service
public class QiniuObjects {
    private static final long FORM_TOKEN_TTL=900;
    private static final String DEFAULT_MANAGEMENT_ENDPOINT="https://rs.qiniuapi.com";
    private final StorageService configs;
    private final boolean allowPrivate;
    private final ObjectMapper json=new ObjectMapper();

    public QiniuObjects(StorageService configs,@Value("${ufm.storage.allow-private-endpoints:false}") boolean allowPrivate) {
        this.configs=configs; this.allowPrivate=allowPrivate;
    }

    private Map<String,Object> config(UUID id) {
        if (!"QINIU".equals(configs.requireEnabled(id).getProvider())) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        return configs.config(id);
    }
    private String value(Map<String,Object> c,String key) {
        if (!(c.get(key) instanceof String s) || s.isBlank() || s.indexOf('\n')>=0 || s.indexOf('\r')>=0)
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return s;
    }
    private URI base(Map<String,Object> c,String key) {
        URI uri=SafeEndpoint.validate(value(c,key),allowPrivate);
        if (uri.getQuery()!=null || uri.getFragment()!=null || !(uri.getPath().isEmpty()||uri.getPath().equals("/")))
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return uri;
    }
    private URI upload(Map<String,Object> c) {
        return base(c,c.get("uploadEndpoint") instanceof String s && !s.isBlank()?"uploadEndpoint":"endpoint");
    }
    private URI management(Map<String,Object> c) {
        String endpoint=c.get("rsEndpoint") instanceof String s && !s.isBlank()?s:DEFAULT_MANAGEMENT_ENDPOINT;
        URI uri=SafeEndpoint.validate(endpoint,allowPrivate);
        if (uri.getQuery()!=null || uri.getFragment()!=null || !(uri.getPath().isEmpty()||uri.getPath().equals("/")))
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return uri;
    }
    private URI download(Map<String,Object> c) { return base(c,c.get("customDomain") instanceof String s && !s.isBlank()?"customDomain":"endpoint"); }
    private static String root(URI uri) {
        String value=uri.toString();
        return value.endsWith("/")?value.substring(0,value.length()-1):value;
    }
    private static String segment(String value) { return URLEncoder.encode(value,StandardCharsets.UTF_8).replace("+","%20").replace("%2F","/"); }
    private static String path(String key) {
        if (key.isBlank() || key.contains("..") || key.startsWith("/")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        StringBuilder builder=new StringBuilder();
        for (String part:key.split("/",-1)) builder.append('/').append(segment(part));
        return builder.toString();
    }
    private static byte[] hmacSha1(String secret,String value) {
        try {
            Mac mac=Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8),"HmacSHA1"));
            return mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException ex) { throw new IllegalStateException(ex); }
    }
    private static String urlSafe(byte[] value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value); }
    private static String entry(String bucket,String key) { return urlSafe((bucket+":"+key).getBytes(StandardCharsets.UTF_8)); }

    private String uptoken(Map<String,Object> c,String key) {
        try {
            String policy=json.writeValueAsString(new TreeMap<>(Map.of("scope",value(c,"bucket")+":"+key,
                    "deadline",Instant.now().getEpochSecond()+FORM_TOKEN_TTL)));
            // 七牛 uploadToken 格式：<AccessKey>:<EncodedSign>:<EncodedPutPolicy>，签名对象是编码后的策略串。
            String encodedPolicy=urlSafe(policy.getBytes(StandardCharsets.UTF_8));
            return value(c,"accessKey")+":"+urlSafe(hmacSha1(value(c,"secretKey"),encodedPolicy))+":"+encodedPolicy;
        } catch (IOException ex) { throw new IllegalStateException(ex); }
    }

    public Form form(UUID id,String key,long size) {
        Map<String,Object> c=config(id);
        Map<String,String> fields=new LinkedHashMap<>();
        fields.put("token",uptoken(c,key));
        fields.put("key",key);
        return new Form(root(upload(c))+"/",fields,FORM_TOKEN_TTL);
    }
    public record Form(String uploadUrl,Map<String,String> fields,long expiresIn) {}

    private CloseableHttpClient client() {
        var registry=RegistryBuilder.<ConnectionSocketFactory>create().register("http",PlainConnectionSocketFactory.getSocketFactory())
                .register("https",SSLConnectionSocketFactory.getSocketFactory()).build();
        var manager=allowPrivate?new PoolingHttpClientConnectionManager(registry):new PoolingHttpClientConnectionManager(registry,new PublicDnsResolver());
        manager.setMaxTotal(4); manager.setDefaultMaxPerRoute(2);
        return HttpClients.custom().setConnectionManager(manager).disableRedirectHandling().disableAutomaticRetries().disableContentCompression()
                .setDefaultRequestConfig(RequestConfig.custom().setConnectTimeout(5000).setSocketTimeout(30000).setConnectionRequestTimeout(5000).build()).build();
    }

    private final class Reply implements AutoCloseable {
        final CloseableHttpClient client; final CloseableHttpResponse response;
        Reply(CloseableHttpClient client,CloseableHttpResponse response) { this.client=client; this.response=response; }
        int status() { return response.getStatusLine().getStatusCode(); }
        String header(String name) { var header=response.getFirstHeader(name); return header==null?null:header.getValue(); }
        InputStream body() throws IOException { return response.getEntity()==null?InputStream.nullInputStream():response.getEntity().getContent(); }
        @Override public void close() throws IOException { try { response.close(); } finally { client.close(); } }
    }
    private Reply execute(HttpRequestBase request) {
        var transport=client();
        try { return new Reply(transport,transport.execute(request)); }
        catch (IOException ex) { try { transport.close(); } catch (IOException ignored) {} throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    private static void success(Reply reply) {
        if (reply.status()<200 || reply.status()>=300) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
    }

    public void put(UUID id,String key,Path path) { put(config(id),key,path); }
    private void put(Map<String,Object> c,String key,Path path) {
        HttpPost post=new HttpPost(root(upload(c))+"/");
        post.setEntity(multipart(uptoken(c,key),key,path));
        try (var reply=execute(post)) { success(reply); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    /** 流式 multipart：不把文件读入内存（2C2G 目标下大文件必须逐块写出）。 */
    private static HttpEntity multipart(String token,String key,Path path) {
        String boundary="ufm-"+UUID.randomUUID();
        byte[] head=("--"+boundary+"\r\nContent-Disposition: form-data; name=\"token\"\r\n\r\n"+token+"\r\n"
                +"--"+boundary+"\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\n"+key+"\r\n"
                +"--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"upload.bin\"\r\n"
                +"Content-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8);
        byte[] tail=("\r\n--"+boundary+"--\r\n").getBytes(StandardCharsets.UTF_8);
        return new HttpEntity() {
            @Override public boolean isRepeatable() { return false; }
            @Override public boolean isChunked() { return true; }
            @Override public long getContentLength() { return -1; }
            @Override public Header getContentType() { return new BasicHeader("Content-Type","multipart/form-data; boundary="+boundary); }
            @Override public Header getContentEncoding() { return null; }
            @Override public InputStream getContent() { throw new UnsupportedOperationException(); }
            @Override public void writeTo(OutputStream out) throws IOException {
                out.write(head);
                try (InputStream in=Files.newInputStream(path)) { in.transferTo(out); }
                out.write(tail);
            }
            @Override public boolean isStreaming() { return true; }
            @Override public void consumeContent() {}
        };
    }

    public void get(UUID id,String key,Path target) { get(config(id),key,target); }
    private void get(Map<String,Object> c,String key,Path target) {
        try (var reply=execute(downloadRequest(c,key,null))) {
            success(reply);
            try (var in=reply.body()) { Files.copy(in,target,StandardCopyOption.REPLACE_EXISTING); }
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    private HttpGet downloadRequest(Map<String,Object> c,String key,String range) {
        String url=root(download(c))+path(key);
        if (Boolean.TRUE.equals(c.get("private"))) {
            long expiry=Instant.now().getEpochSecond()+300;
            String token=value(c,"accessKey")+":"+urlSafe(hmacSha1(value(c,"secretKey"),"/"+key+"?e="+expiry));
            url+="?e="+expiry+"&token="+URLEncoder.encode(token,StandardCharsets.UTF_8);
        }
        HttpGet get=new HttpGet(url);
        if (range!=null) get.setHeader("Range",range);
        return get;
    }

    /** 下载/预览直链：私有空间附带有时效的下载 token，公开空间直接用自定义域名或源站地址。 */
    public String url(UUID id,String key) {
        var c=config(id);
        String base=root(download(c))+path(key);
        if (!Boolean.TRUE.equals(c.get("private"))) return base;
        long expiry=Instant.now().getEpochSecond()+300;
        String token=value(c,"accessKey")+":"+urlSafe(hmacSha1(value(c,"secretKey"),"/"+key+"?e="+expiry));
        return base+"?e="+expiry+"&token="+URLEncoder.encode(token,StandardCharsets.UTF_8);
    }

    public long size(UUID id,String key) { return size(config(id),key); }
    private long size(Map<String,Object> c,String key) {
        String encoded=entry(value(c,"bucket"),key);
        HttpPost post=new HttpPost(root(management(c))+"/stat/"+encoded);
        authorizeManagement(post,c);
        try (var reply=execute(post)) {
            if (reply.status()==612) return -1;
            success(reply);
            var node=json.readTree(reply.body().readNBytes(65536));
            if (!node.path("fsize").isIntegralNumber()) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
            return node.path("fsize").asLong();
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }

    public void remove(UUID id,String key) { remove(config(id),key); }
    private void remove(Map<String,Object> c,String key) {
        String encoded=entry(value(c,"bucket"),key);
        HttpPost post=new HttpPost(root(management(c))+"/delete/"+encoded);
        authorizeManagement(post,c);
        try (var reply=execute(post)) { if (reply.status()!=612) success(reply); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }

    public void copy(UUID id,String source,String target) {
        Map<String,Object> c=config(id);
        String bucket=value(c,"bucket");
        HttpPost post=new HttpPost(root(management(c))+"/copy/"+entry(bucket,source)+"/"+entry(bucket,target)+"/force/false");
        authorizeManagement(post,c);
        try (var reply=execute(post)) { success(reply); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }

    private void authorizeManagement(HttpRequestBase request,Map<String,Object> c) {
        String rawPath=request.getURI().getRawPath();
        String signature=urlSafe(hmacSha1(value(c,"secretKey"),rawPath+"\n"));
        request.setHeader("Authorization","Qiniu "+value(c,"accessKey")+":"+signature);
    }

    public InputStream openRange(UUID id,String key,long start,long length) {
        if (start<0 || length<=0) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        long end=Math.addExact(start,length-1);
        var reply=execute(downloadRequest(config(id),key,"bytes="+start+"-"+end));
        try {
            success(reply);
            if (reply.status()!=206 || !Long.toString(length).equals(reply.header("Content-Length"))
                    || reply.header("Content-Range")==null || !reply.header("Content-Range").startsWith("bytes "+start+"-"+end+"/"))
                throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
            return new FilterInputStream(reply.body()) { @Override public void close() throws IOException { reply.close(); } };
        } catch (RuntimeException | IOException ex) {
            try { reply.close(); } catch (IOException ignored) {}
            throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        }
    }

    public StorageDtos.Probe probe(Map<String,Object> c) {
        long start=System.nanoTime(); String key="ufm-probe/"+UUID.randomUUID(); Path source=null,target=null;
        try {
            source=Files.createTempFile("ufm-qiniu-probe-",".tmp"); target=source.resolveSibling(source.getFileName()+"-verify");
            byte[] bytes=new byte[1024]; new java.security.SecureRandom().nextBytes(bytes); Files.write(source,bytes);
            try {
                put(c,key,source); get(c,key,target);
                if (!java.security.MessageDigest.isEqual(bytes,Files.readAllBytes(target))) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
            } finally { remove(c,key); }
            return new StorageDtos.Probe(true,(System.nanoTime()-start)/1_000_000);
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        finally {
            try { if (source!=null) Files.deleteIfExists(source); if (target!=null) Files.deleteIfExists(target); }
            catch (IOException ignored) {}
        }
    }
}
