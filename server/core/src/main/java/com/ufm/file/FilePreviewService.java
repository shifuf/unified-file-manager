package com.ufm.file;

import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;
import com.ufm.common.error.*;
import org.springframework.http.*;
import org.springframework.core.io.FileSystemResource;

@Service
public class FilePreviewService {
    private final FileService files;
    private final com.ufm.storage.ObjectStore objects;
    private final com.ufm.media.MediaMapper media;
    private final com.fasterxml.jackson.databind.ObjectMapper json;
    public FilePreviewService(FileService files,com.ufm.storage.ObjectStore objects,com.ufm.media.MediaMapper media,com.fasterxml.jackson.databind.ObjectMapper json) {
        this.files=files; this.objects=objects; this.media=media; this.json=json;
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="FilePreview")
    public record Preview(String kind,String content,boolean truncated,boolean hlsReady) {
        public Preview(String kind,String content,boolean truncated) { this(kind,content,truncated,false); }
    }
    public Preview get(java.util.UUID id) {
        var row=files.require(id,false); String text=row.getContentText();
        if (raster(row.getMime())) return new Preview("IMAGE","",false);
        if (java.util.Set.of("video/mp4","video/webm").contains(row.getMime())) return new Preview("VIDEO","",false,media.derivativeInfo(id,"HLS")!=null);
        if (audio(row.getMime())) return new Preview("AUDIO","",false);
        if ("application/pdf".equals(row.getMime())) return new Preview("PDF","",false);
        if (office(row.getMime())) return new Preview("OFFICE","",false);
        if (text==null || text.isEmpty()) return new Preview("UNAVAILABLE","",false);
        int limit=Math.min(262144,text.length());
        return new Preview("TEXT",text.substring(0,limit),text.length()>limit);
    }
    private boolean raster(String mime) {
        return java.util.Set.of("image/png","image/jpeg","image/gif","image/webp","image/avif").contains(mime);
    }
    private boolean audio(String mime) {
        return java.util.Set.of("audio/mpeg","audio/wav","audio/ogg","audio/flac","audio/mp4").contains(mime);
    }
    private boolean office(String mime) {
        return java.util.Set.of("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation").contains(mime);
    }
    public ResponseEntity<?> content(java.util.UUID id,String range) {
        var row=files.require(id,false);
        // Never serve HTML or SVG as same-origin active content, even with an inline disposition.
        if (!raster(row.getMime()) && !audio(row.getMime()) && !java.util.Set.of("video/mp4","video/webm","application/pdf").contains(row.getMime()))
            throw new ApiException(ErrorCode.UNSUPPORTED_MEDIA_TYPE);
        var mp4=media.derivativeInfo(id,"MP4_720");
        if (row.getMime().startsWith("video/") && mp4!=null)
            return stream(mp4.storageConfigId(),mp4.storageKey(),mp4.mime(),mp4.size(),range);
        return stream(row.getStorageConfigId(),row.getStorageKey(),row.getMime(),row.getSize(),range);
    }
    public ResponseEntity<?> hls(java.util.UUID id,String asset,String range) {
        files.require(id,false);
        if (!asset.matches("(?:master|360|720)\\.m3u8|(?:360|720)-[0-9]{5}\\.ts")) throw new ApiException(ErrorCode.NOT_FOUND);
        var derivative=media.derivativeInfo(id,"HLS");
        if (derivative==null) throw new ApiException(ErrorCode.NOT_FOUND);
        try {
            var metadata=json.readTree(media.hlsMetadata(id)); boolean allowed=false;
            for (var name:metadata.path("assets")) if (asset.equals(name.asText())) allowed=true;
            if (!allowed) throw new ApiException(ErrorCode.NOT_FOUND);
            String key=metadata.path("prefix").asText()+"/"+asset.replace('.','_');
            return stream(derivative.storageConfigId(),key,asset.endsWith(".ts")?"video/mp2t":"application/vnd.apple.mpegurl",
                    objects.size(derivative.storageConfigId(),key),range);
        } catch (java.io.IOException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    private ResponseEntity<?> stream(java.util.UUID storage,String key,String mime,long size,String range) {
        if (size<0) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        ByteRange selected=null;
        if (range!=null) try { selected=ByteRange.parse(range,size); }
        catch (IllegalArgumentException ex) { return ResponseEntity.status(416).header("Content-Range","bytes */"+size).build(); }
        boolean local=objects.local(storage);
        var response=ResponseEntity.status(!local && selected!=null?206:200).header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff")
                .header("Content-Security-Policy","default-src 'none'; sandbox").header("Accept-Ranges","bytes")
                .contentType(MediaType.parseMediaType(mime));
        if (local) return response.body(new FileSystemResource(objects.path(storage,key)));
        long start=selected==null?0:selected.start(),length=selected==null?size:selected.length();
        if (selected!=null) response.header("Content-Range","bytes "+selected.start()+"-"+selected.end()+"/"+size);
        // Lazy stream: HEAD never opens the upstream. The converter closes both stream and client after disconnects.
        return response.contentLength(length).body(new org.springframework.core.io.InputStreamResource(
                ()->objects.openRange(storage,key,start,length),"Private preview"));
    }
}
