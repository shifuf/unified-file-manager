package com.ufm.storage;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.error.*;
import org.apache.http.HttpEntity;
import org.apache.http.client.config.RequestConfig;
import org.apache.http.client.methods.*;
import org.apache.http.config.RegistryBuilder;
import org.apache.http.conn.socket.*;
import org.apache.http.conn.ssl.SSLConnectionSocketFactory;
import org.apache.http.entity.ContentType;
import org.apache.http.entity.FileEntity;
import org.apache.http.impl.client.*;
import org.apache.http.impl.conn.PoolingHttpClientConnectionManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.*;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 又拍云 REST/表单原生驱动：操作员签名（method&uri&date&policy&content-md5），
 * 支持 PUT/COPY/GET/HEAD/DELETE 与 Range。
 */
@Service
public class UpyunObjects {
    private static final long FORM_TTL=900;
    private static final DateTimeFormatter HTTP_DATE=DateTimeFormatter.RFC_1123_DATE_TIME.withZone(ZoneOffset.UTC);
    private final StorageService configs;
    private final boolean allowPrivate;

    public UpyunObjects(StorageService configs,@Value("${ufm.storage.allow-private-endpoints:false}") boolean allowPrivate) {
        this.configs=configs; this.allowPrivate=allowPrivate;
    }

    private Map<String,Object> config(UUID id) {
        if (!"UPYUN".equals(configs.requireEnabled(id).getProvider())) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        return configs.config(id);
    }
    private String value(Map<String,Object> c,String key) {
        if (!(c.get(key) instanceof String s) || s.isBlank() || s.indexOf('\n')>=0 || s.indexOf('\r')>=0)
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return s;
    }
    private URI endpoint(Map<String,Object> c) {
        URI uri=SafeEndpoint.validate(value(c,"endpoint"),allowPrivate);
        if (uri.getQuery()!=null || uri.getFragment()!=null || !(uri.getPath().isEmpty()||uri.getPath().equals("/")))
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return uri;
    }
    private URI download(Map<String,Object> c) {
        if (!(c.get("customDomain") instanceof String domain) || domain.isBlank()) return endpoint(c);
        URI uri=SafeEndpoint.validate(domain,allowPrivate);
        if (uri.getQuery()!=null || uri.getFragment()!=null || !(uri.getPath().isEmpty()||uri.getPath().equals("/")))
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return uri;
    }
    private static String root(URI uri) {
        String value=uri.toString();
        return value.endsWith("/")?value.substring(0,value.length()-1):value;
    }
    private static String segment(String value) { return URLEncoder.encode(value,StandardCharsets.UTF_8).replace("+","%20").replace("%2F","/"); }
    private URI object(Map<String,Object> c,String key) {
        if (key.isBlank() || key.contains("..") || key.startsWith("/")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        String service=value(c,"service");
        if (!service.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        StringBuilder builder=new StringBuilder();
        for (String part:key.split("/",-1)) builder.append('/').append(segment(part));
        try { return SafeEndpoint.validate(root(endpoint(c))+"/"+service+builder,allowPrivate); }
        catch (RuntimeException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }
    private static String md5Hex(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(value)); }
        catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
    private static String sign(String method,String uri,String date,String policy,String contentMd5,String password) {
        String raw=String.join("&",java.util.stream.Stream.of(method,uri,date,policy,contentMd5)
                .filter(value->value!=null && !value.isEmpty()).toList());
        String key=md5Hex(password.getBytes(StandardCharsets.UTF_8));
        try {
            javax.crypto.Mac mac=javax.crypto.Mac.getInstance("HmacSHA1");
            mac.init(new javax.crypto.spec.SecretKeySpec(key.getBytes(StandardCharsets.UTF_8),"HmacSHA1"));
            return Base64.getEncoder().encodeToString(mac.doFinal(raw.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException ex) { throw new IllegalStateException(ex); }
    }

    /** 下载直链优先使用自定义域名；未配置时使用 REST 源站。 */
    public String url(UUID id,String key) {
        Map<String,Object> c=config(id);
        if (!(c.get("customDomain") instanceof String domain) || domain.isBlank()) return object(c,key).toString();
        StringBuilder path=new StringBuilder();
        for (String part:key.split("/",-1)) path.append('/').append(segment(part));
        return root(download(c))+path;
    }
    public Form form(UUID id,String key,long size) {
        Map<String,Object> c=config(id);
        String service=value(c,"service");
        String policy=policy(c,key,size);
        Map<String,String> fields=new LinkedHashMap<>();
        fields.put("authorization","UPYUN "+value(c,"operator")+":"+sign("POST","/"+service,"",policy,"",value(c,"password")));
        fields.put("policy",policy);
        return new Form(root(endpoint(c))+"/"+service,fields,FORM_TTL);
    }
    public record Form(String uploadUrl,Map<String,String> fields,long expiresIn) {}
    private String policy(Map<String,Object> c,String key,long size) {
        Map<String,Object> policy=new LinkedHashMap<>();
        policy.put("bucket",value(c,"service"));
        policy.put("save-key","/"+key);
        policy.put("expiration",Instant.now().getEpochSecond()+FORM_TTL);
        policy.put("content-length-range",List.of(size,size));
        try { return new ObjectMapper().writeValueAsString(policy); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private void authorize(HttpRequestBase request,Map<String,Object> c,String contentMd5) {
        String date=HTTP_DATE.format(ZonedDateTime.now(ZoneOffset.UTC));
        String digest=contentMd5==null?"":contentMd5;
        String uri=request.getURI().getPath();
        request.setHeader("Date",date);
        if (!digest.isEmpty()) request.setHeader("Content-MD5",digest);
        request.setHeader("Authorization","UPYUN "+value(c,"operator")+":"+sign(request.getMethod(),uri,date,"",digest,value(c,"password")));
    }

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
        HttpPut put=new HttpPut(object(c,key));
        try { authorize(put,c,md5(path)); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        put.setEntity(new FileEntity(path.toFile(),ContentType.APPLICATION_OCTET_STREAM));
        try (var reply=execute(put)) { success(reply); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    private static String md5(Path path) throws IOException {
        try {
            MessageDigest digest=MessageDigest.getInstance("MD5");
            try (InputStream in=Files.newInputStream(path)) {
                byte[] buffer=new byte[65536]; int read;
                while ((read=in.read(buffer))!=-1) digest.update(buffer,0,read);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
    public void get(UUID id,String key,Path target) { get(config(id),key,target); }
    private void get(Map<String,Object> c,String key,Path target) {
        HttpGet get=new HttpGet(object(c,key)); authorize(get,c,null);
        try (var reply=execute(get)) {
            success(reply);
            try (var in=reply.body()) { Files.copy(in,target,StandardCopyOption.REPLACE_EXISTING); }
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public long size(UUID id,String key) { return size(config(id),key); }
    private long size(Map<String,Object> c,String key) {
        HttpHead head=new HttpHead(object(c,key)); authorize(head,c,null);
        try (var reply=execute(head)) {
            if (reply.status()==404) return -1;
            success(reply);
            String value=reply.header("x-upyun-file-size");
            return Long.parseLong(value==null?reply.header("Content-Length"):value);
        } catch (IOException | NumberFormatException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void remove(UUID id,String key) { remove(config(id),key); }
    private void remove(Map<String,Object> c,String key) {
        HttpDelete delete=new HttpDelete(object(c,key)); authorize(delete,c,null);
        try (var reply=execute(delete)) { if (reply.status()!=404) success(reply); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void copy(UUID id,String source,String target) {
        Map<String,Object> c=config(id);
        HttpPut put=new HttpPut(object(c,target));
        put.setHeader("X-Upyun-Copy-Source","/"+value(c,"service")+"/"+source);
        authorize(put,c,null);
        try (var reply=execute(put)) { success(reply); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public InputStream openRange(UUID id,String key,long start,long length) {
        if (start<0 || length<=0) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        long end=Math.addExact(start,length-1);
        Map<String,Object> c=config(id);
        HttpGet get=new HttpGet(object(c,key)); get.setHeader("Range","bytes="+start+"-"+end); authorize(get,c,null);
        var reply=execute(get);
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
            source=Files.createTempFile("ufm-upyun-probe-",".tmp"); target=source.resolveSibling(source.getFileName()+"-verify");
            byte[] bytes=new byte[1024]; new java.security.SecureRandom().nextBytes(bytes); Files.write(source,bytes);
            try {
                put(c,key,source); get(c,key,target);
                if (!MessageDigest.isEqual(bytes,Files.readAllBytes(target))) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
            } finally { remove(c,key); }
            return new StorageDtos.Probe(true,(System.nanoTime()-start)/1_000_000);
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        finally {
            try { if (source!=null) Files.deleteIfExists(source); if (target!=null) Files.deleteIfExists(target); }
            catch (IOException ignored) {}
        }
    }
}
