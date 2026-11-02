package com.ufm.backup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.crypto.SecretCipher;
import com.ufm.common.error.*;
import com.ufm.file.UploadMapper;
import com.ufm.storage.*;
import jakarta.validation.constraints.*;
import org.apache.http.client.methods.*;
import org.apache.http.config.RegistryBuilder;
import org.apache.http.conn.socket.*;
import org.apache.http.conn.ssl.SSLConnectionSocketFactory;
import org.apache.http.impl.conn.PoolingHttpClientConnectionManager;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.entity.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

@Service
public class RemoteBackupService {
    @io.swagger.v3.oas.annotations.media.Schema(name="RemoteBackupInput")
    public record Input(boolean enabled,@NotBlank @Size(max=2048) String endpoint,@NotBlank @Size(max=256) String username,
                        @Size(min=1,max=1024) String password,@Min(1) @Max(1000) int retention,@Min(0) @Max(23) int hourUtc) {}
    public record Config(boolean enabled,String endpoint,String username,String password,int retention,int hourUtc) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="RemoteBackupSettings")
    public record View(boolean enabled,String endpoint,String username,boolean passwordConfigured,int retention,int hourUtc) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="RemoteBackupFile")
    public record Entry(String name,long size) {}
    private final UploadMapper settings;
    private final SecretCipher cipher;
    private final ObjectMapper json;
    private final boolean allowPrivate;
    public RemoteBackupService(UploadMapper settings,SecretCipher cipher,ObjectMapper json,@Value("${ufm.outbound.allow-private-endpoints:false}") boolean allowPrivate) {
        this.settings=settings; this.cipher=cipher; this.json=json; this.allowPrivate=allowPrivate;
    }
    private Config config() {
        String value=settings.manifest("backup.remote");
        if (value==null) return null;
        try { return json.readValue(cipher.decrypt(json.readTree(value).path("enc").asText()),Config.class); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public View get() { Config c=config(); return c==null?new View(false,"","",false,7,3):view(c); }
    private View view(Config c) { return new View(c.enabled(),c.endpoint(),c.username(),!c.password().isEmpty(),c.retention(),c.hourUtc()); }
    public View put(Input input) throws Exception {
        URI uri=SafeEndpoint.validate(input.endpoint(),allowPrivate);
        if (uri.getQuery()!=null || !uri.getPath().endsWith("/") || input.username().contains(":") || input.username().contains("\r") || input.username().contains("\n"))
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        Config old=config(); String password=input.password()==null?(old==null?"":old.password()):input.password();
        if (password.isEmpty()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        Config c=new Config(input.enabled(),uri.toASCIIString(),input.username(),password,input.retention(),input.hourUtc());
        settings.save("backup.remote",json.writeValueAsString(Map.of("enc",cipher.encrypt(json.writeValueAsString(c))))); return view(c);
    }
    public boolean enabled() { var c=config(); return c!=null && c.enabled(); }
    public int hourUtc() { var c=config(); return c==null?3:c.hourUtc(); }
    private Config require() { Config c=config(); if (c==null || !c.enabled()) throw new ApiException(ErrorCode.CONFLICT); return c; }
    private static boolean owned(String name) { return name!=null && name.matches("ufm-[0-9]{14}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.zip"); }
    private URI target(Config c,String name) { if (name.contains("/") || name.contains("\\")) throw new ApiException(ErrorCode.INVALID_ARGUMENT); return URI.create(c.endpoint()).resolve(name); }
    private static class Request extends HttpEntityEnclosingRequestBase {
        private final String method;
        Request(String method,URI uri) { this.method=method; setURI(uri); }
        @Override public String getMethod() { return method; }
    }
    private byte[] request(Config c,String method,String name,Path upload,Path download) throws Exception {
        URI uri=target(c,name); SafeEndpoint.validate(uri.toString(),allowPrivate);
        var registry=RegistryBuilder.<ConnectionSocketFactory>create().register("http",PlainConnectionSocketFactory.getSocketFactory())
                .register("https",SSLConnectionSocketFactory.getSocketFactory()).build();
        var manager=allowPrivate?new PoolingHttpClientConnectionManager(registry):new PoolingHttpClientConnectionManager(registry,new PublicDnsResolver());
        manager.setMaxTotal(2); manager.setDefaultMaxPerRoute(2);
        try (var client=HttpClients.custom().setConnectionManager(manager).disableRedirectHandling().disableAutomaticRetries()
                .setDefaultRequestConfig(org.apache.http.client.config.RequestConfig.custom().setConnectTimeout(5000).setSocketTimeout(60000).setConnectionRequestTimeout(5000).build()).build()) {
            var request=new Request(method,uri); request.setHeader("Authorization","Basic "+Base64.getEncoder().encodeToString((c.username()+":"+c.password()).getBytes(StandardCharsets.UTF_8)));
            if (method.equals("PROPFIND")) { request.setHeader("Depth","1"); request.setEntity(new StringEntity("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:getcontentlength/></d:prop></d:propfind>",ContentType.APPLICATION_XML)); }
            if (upload!=null) request.setEntity(new FileEntity(upload.toFile(),ContentType.APPLICATION_OCTET_STREAM));
            try (var response=client.execute(request)) {
                int status=response.getStatusLine().getStatusCode();
                if (!(status>=200 && status<300) && !(method.equals("DELETE") && status==404)) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
                if (response.getEntity()==null) return new byte[0];
                try (var in=response.getEntity().getContent()) {
                    if (download!=null) {
                        try (var out=Files.newOutputStream(download)) {
                            long total=0; byte[] buffer=new byte[65536]; int n;
                            while ((n=in.read(buffer))!=-1) { total+=n; if (total>100L*1024*1024*1024) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE); out.write(buffer,0,n); }
                        }
                        return new byte[0];
                    }
                    byte[] result=in.readNBytes(4*1024*1024+1); if (result.length>4*1024*1024) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE); return result;
                }
            }
        }
    }
    public void test() throws Exception {
        Config c=require(); String name="ufm-probe-"+UUID.randomUUID(); Path source=Files.createTempFile("ufm-dav-probe-",".bin"),download=Files.createTempFile("ufm-dav-probe-",".bin");
        try {
            byte[] bytes=new byte[1024]; new java.security.SecureRandom().nextBytes(bytes); Files.write(source,bytes);
            request(c,"PUT",name,source,null); request(c,"GET",name,null,download);
            if (!java.security.MessageDigest.isEqual(bytes,Files.readAllBytes(download))) throw new ApiException(ErrorCode.CONFLICT);
        } finally { try { request(c,"DELETE",name,null,null); } finally { Files.deleteIfExists(source); Files.deleteIfExists(download); } }
    }
    public List<Entry> list() throws Exception {
        Config c=require(); byte[] xml=request(c,"PROPFIND","",null,null);
        var factory=javax.xml.parsers.DocumentBuilderFactory.newInstance(); factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities",false); factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false);
        factory.setAttribute(javax.xml.XMLConstants.ACCESS_EXTERNAL_DTD,""); factory.setAttribute(javax.xml.XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");
        org.w3c.dom.Document document;
        try { document=factory.newDocumentBuilder().parse(new java.io.ByteArrayInputStream(xml)); }
        catch (org.xml.sax.SAXException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
        var responses=document.getElementsByTagNameNS("DAV:","response"); Map<String,Entry> entries=new TreeMap<>();
        URI base=URI.create(c.endpoint());
        for (int i=0;i<responses.getLength();i++) {
            var element=(org.w3c.dom.Element)responses.item(i); var hrefs=element.getElementsByTagNameNS("DAV:","href"); if (hrefs.getLength()!=1) continue;
            URI href=base.resolve(hrefs.item(0).getTextContent()).normalize();
            if (!Objects.equals(base.getScheme(),href.getScheme()) || !Objects.equals(base.getRawAuthority(),href.getRawAuthority()) || !href.getPath().startsWith(base.getPath())) continue;
            String name=href.getPath().substring(base.getPath().length()); if (!owned(name)) continue;
            var lengths=element.getElementsByTagNameNS("DAV:","getcontentlength"); long size=-1;
            if (lengths.getLength()>0) try { size=Long.parseLong(lengths.item(0).getTextContent()); } catch (NumberFormatException ignored) {}
            entries.put(name,new Entry(name,size));
        }
        return entries.values().stream().sorted(Comparator.comparing(Entry::name).reversed()).toList();
    }
    public void sync(UUID id,Path archive) throws Exception {
        if (!enabled()) return; Config c=require();
        String name="ufm-"+java.time.format.DateTimeFormatter.ofPattern("yyyyMMddHHmmss").withZone(java.time.ZoneOffset.UTC).format(java.time.Instant.now())+"-"+id+".zip";
        request(c,"PUT",name,archive,null);
        Path verified=Files.createTempFile("ufm-remote-verify-",".zip");
        try {
            request(c,"GET",name,null,verified);
            if (Files.size(archive)!=Files.size(verified) || Files.mismatch(archive,verified)!=-1) throw new ApiException(ErrorCode.CONFLICT);
        } finally { Files.deleteIfExists(verified); }
        var entries=list(); for (int i=c.retention();i<entries.size();i++) request(c,"DELETE",entries.get(i).name(),null,null);
    }
    public Path fetch(String name) throws Exception {
        if (!owned(name)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        if (list().stream().noneMatch(entry->entry.name().equals(name))) throw new ApiException(ErrorCode.NOT_FOUND);
        Path temp=Files.createTempFile("ufm-remote-import-",".zip");
        try { request(require(),"GET",name,null,temp); return temp; }
        catch (Exception ex) { Files.deleteIfExists(temp); throw ex; }
    }
}
