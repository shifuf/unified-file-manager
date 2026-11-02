package com.ufm.storage;

import com.ufm.common.error.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.apache.http.client.methods.*;
import org.apache.http.impl.client.*;
import org.apache.http.impl.conn.PoolingHttpClientConnectionManager;
import org.apache.http.config.RegistryBuilder;
import org.apache.http.conn.socket.*;
import org.apache.http.conn.ssl.SSLConnectionSocketFactory;
import org.apache.http.client.config.RequestConfig;
import org.apache.http.entity.*;
import org.apache.http.HttpEntity;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.SecretKeySpec;

/** Native OSS REST with V4 signing; the transport validates DNS at connection time. */
@Service
public class OssObjects {
    private final StorageService configs;
    private final boolean allowPrivate;
    public OssObjects(StorageService configs,@Value("${ufm.storage.allow-private-endpoints:false}") boolean allowPrivate) { this.configs=configs; this.allowPrivate=allowPrivate; }
    private Map<String,Object> config(UUID id) {
        if (!"OSS".equals(configs.requireEnabled(id).getProvider())) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        return configs.config(id);
    }
    private String value(Map<String,Object> c,String key) {
        if (!(c.get(key) instanceof String s) || s.isBlank() || s.indexOf('\n')>=0 || s.indexOf('\r')>=0) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return s;
    }
    private URI endpoint(Map<String,Object> c,String key) {
        if (!key.matches("[a-zA-Z0-9/_-]+") || key.contains("..")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        String bucket=value(c,"bucket");
        if (!bucket.matches("[a-z0-9][a-z0-9-]{1,61}[a-z0-9]")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        URI uri=SafeEndpoint.validate(value(c,"endpoint"),allowPrivate);
        if (uri.getQuery()!=null || !(uri.getPath().isEmpty() || uri.getPath().equals("/"))) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        // Real OSS uses bucket virtual hosting. The private test override uses path style for the local protocol fixture only.
        String host=uri.getHost(),path="/"+key;
        if (allowPrivate && (host.equals("127.0.0.1") || host.equals("localhost"))) path="/"+bucket+path;
        else host=bucket+"."+host;
        try { return SafeEndpoint.validate(new URI(uri.getScheme(),null,host,uri.getPort(),path,null,null).toString(),allowPrivate); }
        catch (URISyntaxException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }
    private CloseableHttpClient client() {
        var registry=RegistryBuilder.<ConnectionSocketFactory>create().register("http",PlainConnectionSocketFactory.getSocketFactory())
                .register("https",SSLConnectionSocketFactory.getSocketFactory()).build();
        var manager=allowPrivate?new PoolingHttpClientConnectionManager(registry):new PoolingHttpClientConnectionManager(registry,new PublicDnsResolver());
        manager.setMaxTotal(2); manager.setDefaultMaxPerRoute(2);
        return HttpClients.custom().setConnectionManager(manager).disableRedirectHandling().disableAutomaticRetries().disableContentCompression()
                .setDefaultRequestConfig(RequestConfig.custom().setConnectTimeout(5000).setSocketTimeout(30000).setConnectionRequestTimeout(5000).build()).build();
    }
    private static String encode(String s) { return URLEncoder.encode(s,StandardCharsets.UTF_8).replace("+","%20").replace("%7E","~"); }
    private static String query(Map<String,String> params) {
        var encoded=new TreeMap<String,String>(); params.forEach((k,v)->encoded.put(encode(k),encode(v)));
        return encoded.entrySet().stream().map(e->e.getKey()+(e.getValue().isEmpty()?"":"="+e.getValue())).collect(java.util.stream.Collectors.joining("&"));
    }
    private static byte[] hmac(byte[] key,String value) throws GeneralSecurityException { Mac m=Mac.getInstance("HmacSHA256"); m.init(new SecretKeySpec(key,"HmacSHA256")); return m.doFinal(value.getBytes(StandardCharsets.UTF_8)); }
    private String signature(Map<String,Object> c,String method,String key,Map<String,String> params,Map<String,String> headers,String date) {
        try {
            String scope=date.substring(0,8)+"/"+value(c,"region")+"/oss/aliyun_v4_request";
            var canonicalHeaders=new StringBuilder(); new TreeMap<>(headers).forEach((k,v)->{
                if (k.startsWith("x-oss-") || k.equals("content-type") || k.equals("content-md5")) canonicalHeaders.append(k).append(':').append(v.trim()).append('\n');
            });
            String resource="/"+value(c,"bucket")+"/"+key;
            String canonical=method+"\n"+resource+"\n"+query(params)+"\n"+canonicalHeaders+"\n\nUNSIGNED-PAYLOAD";
            String signed="OSS4-HMAC-SHA256\n"+date+"\n"+scope+"\n"+HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8)));
            byte[] signingKey=("aliyun_v4"+value(c,"secretKey")).getBytes(StandardCharsets.UTF_8);
            for (String part:List.of(date.substring(0,8),value(c,"region"),"oss","aliyun_v4_request")) signingKey=hmac(signingKey,part);
            return HexFormat.of().formatHex(hmac(signingKey,signed));
        } catch (GeneralSecurityException ex) { throw new IllegalStateException(ex); }
    }
    private String presign(UUID id,String key,String method,Map<String,String> input) {
        var c=config(id); URI base=endpoint(c,key); String date=DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC).format(Instant.now());
        var params=new TreeMap<>(input); params.put("x-oss-date",date); params.put("x-oss-expires",method.equals("GET")?"300":"900");
        params.put("x-oss-signature-version","OSS4-HMAC-SHA256"); params.put("x-oss-credential",value(c,"accessKey")+"/"+date.substring(0,8)+"/"+value(c,"region")+"/oss/aliyun_v4_request");
        params.put("x-oss-signature",signature(c,method,key,params,Map.of(),date));
        return base+"?"+query(params);
    }
    public String putUrl(UUID id,String key) { return presign(id,key,"PUT",Map.of()); }
    public String getUrl(UUID id,String key) { return presign(id,key,"GET",Map.of("response-content-disposition","attachment")); }
    public String partUrl(UUID id,String key,String upload,int part) { return presign(id,key,"PUT",Map.of("uploadId",upload,"partNumber",Integer.toString(part))); }
    private final class Reply implements AutoCloseable {
        final CloseableHttpClient client; final CloseableHttpResponse response;
        Reply(CloseableHttpClient client,CloseableHttpResponse response) { this.client=client; this.response=response; }
        String header(String name) { var header=response.getFirstHeader(name); return header==null?null:header.getValue(); }
        int status() { return response.getStatusLine().getStatusCode(); }
        InputStream body() throws IOException { return response.getEntity()==null?InputStream.nullInputStream():response.getEntity().getContent(); }
        @Override public void close() throws IOException { try { response.close(); } finally { client.close(); } }
    }
    private Reply execute(Map<String,Object> c,String method,String key,Map<String,String> params,Map<String,String> input,HttpEntity entity) {
        URI base=endpoint(c,key); var headers=new TreeMap<>(input);
        String date=DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC).format(Instant.now());
        headers.put("x-oss-date",date); headers.put("x-oss-content-sha256","UNSIGNED-PAYLOAD");
        String scope=date.substring(0,8)+"/"+value(c,"region")+"/oss/aliyun_v4_request";
        headers.put("Authorization","OSS4-HMAC-SHA256 Credential="+value(c,"accessKey")+"/"+scope+",Signature="+signature(c,method,key,params,headers,date));
        URI uri=URI.create(base+(params.isEmpty()?"":"?"+query(params)));
        HttpRequestBase request=switch (method) { case "GET" -> new HttpGet(uri); case "HEAD" -> new HttpHead(uri); case "DELETE" -> new HttpDelete(uri); case "POST" -> new HttpPost(uri); case "PUT" -> new HttpPut(uri); default -> throw new IllegalArgumentException(); };
        headers.forEach(request::setHeader);
        if (entity!=null) ((HttpEntityEnclosingRequestBase)request).setEntity(entity);
        var transport=client();
        try { return new Reply(transport,transport.execute(request)); }
        catch (IOException ex) { try { transport.close(); } catch (IOException ignored) { } throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    private void requireSuccess(Reply reply) {
        if (reply.status()<200 || reply.status()>=300) throw new ApiException(reply.status()==412?ErrorCode.CONFLICT:ErrorCode.STORAGE_UNAVAILABLE);
    }
    public long size(UUID id,String key) { return size(config(id),key); }
    private long size(Map<String,Object> c,String key) {
        try (var r=execute(c,"HEAD",key,Map.of(),Map.of(),null)) {
            if (r.status()==404) return -1; requireSuccess(r); return Long.parseLong(r.header("Content-Length"));
        } catch (IOException | NumberFormatException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void put(UUID id,String key,Path path) { put(config(id),key,path); }
    private void put(Map<String,Object> c,String key,Path path) {
        try (var r=execute(c,"PUT",key,Map.of(),Map.of("content-type","application/octet-stream"),new FileEntity(path.toFile(),ContentType.APPLICATION_OCTET_STREAM))) { requireSuccess(r); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void get(UUID id,String key,Path path) { get(config(id),key,path); }
    private void get(Map<String,Object> c,String key,Path path) {
        try (var r=execute(c,"GET",key,Map.of(),Map.of(),null)) { requireSuccess(r); try (var in=r.body()) { Files.copy(in,path); } }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void remove(UUID id,String key) { remove(config(id),key); }
    private void remove(Map<String,Object> c,String key) {
        try (var r=execute(c,"DELETE",key,Map.of(),Map.of(),null)) { if (r.status()!=404) requireSuccess(r); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public InputStream openRange(UUID id,String key,long start,long length) {
        if (start<0 || length<=0) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        long end=Math.addExact(start,length-1); var r=execute(config(id),"GET",key,Map.of(),Map.of("Range","bytes="+start+"-"+end),null);
        try {
            requireSuccess(r);
            if (r.status()!=206 || !Long.toString(length).equals(r.header("Content-Length")) || r.header("Content-Range")==null
                    || !r.header("Content-Range").startsWith("bytes "+start+"-"+end+"/")) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
            return new FilterInputStream(r.body()) { @Override public void close() throws IOException { r.close(); } };
        } catch (RuntimeException | IOException ex) { try { r.close(); } catch (IOException ignored) { } throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public String seal(UUID id,String source,String target,long size) {
        var c=config(id); String etag;
        try (var r=execute(c,"HEAD",source,Map.of(),Map.of(),null)) { requireSuccess(r); if (!Long.toString(size).equals(r.header("Content-Length"))) throw new ApiException(ErrorCode.CONFLICT); etag=r.header("ETag"); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        if (etag==null) throw new ApiException(ErrorCode.CONFLICT);
        try (var r=execute(c,"PUT",target,Map.of(),Map.of("x-oss-copy-source","/"+value(c,"bucket")+"/"+source,"x-oss-copy-source-if-match",etag),null)) { requireSuccess(r); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        if (size(c,target)!=size) throw new ApiException(ErrorCode.CONFLICT); return target;
    }
    private String xml(Reply r,String element) throws Exception {
        requireSuccess(r); byte[] bytes=r.body().readNBytes(1048577); if (bytes.length>1048576) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        var factory=javax.xml.parsers.DocumentBuilderFactory.newInstance(); factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities",false); factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false);
        factory.setAttribute(javax.xml.XMLConstants.ACCESS_EXTERNAL_DTD,""); factory.setAttribute(javax.xml.XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");
        var document=factory.newDocumentBuilder().parse(new ByteArrayInputStream(bytes));
        if (document.getElementsByTagName("Error").getLength()>0) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        if (element==null) return "";
        var nodes=document.getElementsByTagName(element); if (nodes.getLength()!=1) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        String value=nodes.item(0).getTextContent(); if (value.isBlank() || value.length()>1024) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); return value;
    }
    public String multipart(UUID id,String key) {
        try (var r=execute(config(id),"POST",key,Map.of("uploads",""),Map.of(),null)) { return xml(r,"UploadId"); }
        catch (ApiException ex) { throw ex; } catch (Exception ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void complete(UUID id,String key,String upload,List<software.amazon.awssdk.services.s3.model.CompletedPart> parts) {
        var body=new StringBuilder("<CompleteMultipartUpload>");
        for (var p:parts) {
            String etag=p.eTag(); if (!etag.matches("[a-zA-Z0-9\"-]{1,200}")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            body.append("<Part><PartNumber>").append(p.partNumber()).append("</PartNumber><ETag>").append(etag.replace("\"","&quot;")).append("</ETag></Part>");
        }
        body.append("</CompleteMultipartUpload>");
        try (var r=execute(config(id),"POST",key,Map.of("uploadId",upload),Map.of("content-type","application/xml"),new ByteArrayEntity(body.toString().getBytes(StandardCharsets.UTF_8),ContentType.APPLICATION_XML))) { xml(r,null); }
        catch (ApiException ex) { throw ex; } catch (Exception ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void abort(UUID id,String key,String upload) {
        try (var r=execute(config(id),"DELETE",key,Map.of("uploadId",upload),Map.of(),null)) { if (r.status()!=404) requireSuccess(r); }
        catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public StorageDtos.Probe probe(Map<String,Object> c) {
        long start=System.nanoTime(); String key="ufm-probe/"+UUID.randomUUID(); Path source=null,target=null;
        try {
            source=Files.createTempFile("ufm-oss-probe-",".tmp"); target=source.resolveSibling(source.getFileName()+"-verify");
            byte[] bytes=new byte[1024]; new SecureRandom().nextBytes(bytes); Files.write(source,bytes);
            try { put(c,key,source); get(c,key,target); if (!MessageDigest.isEqual(bytes,Files.readAllBytes(target))) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
            finally { remove(c,key); }
            return new StorageDtos.Probe(true,(System.nanoTime()-start)/1000000);
        } catch (IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        finally { try { if (source!=null) Files.deleteIfExists(source); if (target!=null) Files.deleteIfExists(target); } catch (IOException ignored) { } }
    }
}
