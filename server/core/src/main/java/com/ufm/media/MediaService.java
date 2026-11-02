package com.ufm.media;

import com.ufm.common.error.*;
import com.ufm.file.FileService;
import com.ufm.storage.ObjectStore;
import org.springframework.http.*;
import org.springframework.core.io.FileSystemResource;
import org.springframework.stereotype.Service;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.util.UUID;

@Service
public class MediaService {
    private final FileService files;
    private final ObjectStore objects;
    private final MediaMapper mapper;
    @org.springframework.beans.factory.annotation.Autowired private MediaProcess process;
    @org.springframework.beans.factory.annotation.Autowired private MediaPublication publication;
    private final com.fasterxml.jackson.databind.ObjectMapper json=new com.fasterxml.jackson.databind.ObjectMapper();
    public MediaService(FileService files,ObjectStore objects,MediaMapper mapper) { this.files=files; this.objects=objects; this.mapper=mapper; }
    public void image(UUID id) throws Exception {
        var file=files.require(id,false); Path dir=Files.createTempDirectory("ufm-image-"); Path source=dir.resolve("source"),output=dir.resolve("thumbnail.png");
        try {
            objects.get(file.getStorageConfigId(),file.getStorageKey(),source);
            BufferedImage image;
            try (var input=ImageIO.createImageInputStream(source.toFile())) {
                var readers=ImageIO.getImageReaders(input); if (!readers.hasNext()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                ImageReader reader=readers.next();
                try {
                    reader.setInput(input,true,true); int width=reader.getWidth(0),height=reader.getHeight(0);
                    if (width<1 || height<1 || (long)width*height>40_000_000) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE);
                    var params=reader.getDefaultReadParam(); int subsample=Math.max(1,Math.max(width,height)/640);
                    params.setSourceSubsampling(subsample,subsample,0,0); image=reader.read(0,params);
                } finally { reader.dispose(); }
            }
            double ratio=Math.min(1,320.0/Math.max(image.getWidth(),image.getHeight()));
            BufferedImage thumb=new BufferedImage(Math.max(1,(int)(image.getWidth()*ratio)),Math.max(1,(int)(image.getHeight()*ratio)),BufferedImage.TYPE_INT_ARGB);
            Graphics2D graphics=thumb.createGraphics();
            try { graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION,RenderingHints.VALUE_INTERPOLATION_BILINEAR); graphics.drawImage(image,0,0,thumb.getWidth(),thumb.getHeight(),null); }
            finally { graphics.dispose(); image.flush(); }
            ImageIO.write(thumb,"png",output.toFile()); thumb.flush();
            store(id,file,"THUMB",output,"image/png");
            Path webp=dir.resolve("image.webp");
            try {
                process.run(dir,java.util.List.of("-i",output.toString(),"-frames:v","1","-c:v","libwebp","-quality","82",webp.toString()));
                store(id,file,"WEBP",webp,"image/webp");
            } finally { Files.deleteIfExists(webp); }
        } finally { Files.deleteIfExists(source); Files.deleteIfExists(output); Files.deleteIfExists(dir); }
    }
    public ResponseEntity<?> thumbnail(UUID id) {
        return derivative(id,"THUMB");
    }
    public void video(UUID id) throws Exception {
        var file=files.require(id,false); Path dir=Files.createTempDirectory("ufm-video-"); Path source=dir.resolve("source");
        try {
            objects.get(file.getStorageConfigId(),file.getStorageKey(),source);
            Path mp4=dir.resolve("video.mp4"),cover=dir.resolve("cover.jpg");
            process.run(dir,java.util.List.of("-protocol_whitelist","file,pipe","-i",source.toString(),"-t","7200","-vf","scale=-2:720","-c:v","libx264","-preset","veryfast","-crf","24","-c:a","aac","-movflags","+faststart",mp4.toString()));
            store(id,file,"MP4_720",mp4,"video/mp4");
            process.run(dir,java.util.List.of("-protocol_whitelist","file,pipe","-i",mp4.toString(),"-frames:v","1","-vf","scale=-2:320",cover.toString()));
            store(id,file,"COVER",cover,"image/jpeg");
            for (int height:new int[]{360,720}) {
                String name=Integer.toString(height);
                process.run(dir,java.util.List.of("-protocol_whitelist","file,pipe","-i",mp4.toString(),"-vf","scale=-2:"+height,"-c:v","libx264","-preset","veryfast","-crf","26","-c:a","aac","-force_key_frames","expr:gte(t,n_forced*3)","-hls_time","3","-hls_playlist_type","vod","-hls_segment_filename",dir.resolve(name+"-%05d.ts").toString(),dir.resolve(name+".m3u8").toString()));
            }
            Files.writeString(dir.resolve("master.m3u8"),"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\n720.m3u8\n");
            String prefix=file.getProjectId()+"/hls/"+UUID.randomUUID(); java.util.List<String> assets=new java.util.ArrayList<>();
            try (var paths=Files.list(dir)) { for (Path asset:paths.toList()) {
                String name=asset.getFileName().toString();
                if (name.endsWith(".m3u8") || name.endsWith(".ts")) { objects.put(file.getStorageConfigId(),prefix+"/"+name.replace('.','_'),asset); assets.add(name); }
            } }
            publication.publish(file,"HLS",prefix+"/master_m3u8","application/vnd.apple.mpegurl",Files.size(dir.resolve("master.m3u8")),
                    json.writeValueAsString(java.util.Map.of("prefix",prefix,"assets",assets)),assets.stream().map(name->new com.ufm.file.FileMapper.ObjectRef(file.getStorageConfigId(),prefix+"/"+name.replace('.','_'))).toList());
        } finally { try (var paths=Files.list(dir)) { for (Path path:paths.toList()) Files.deleteIfExists(path); } Files.deleteIfExists(dir); }
    }
    public ResponseEntity<?> hls(UUID id,String asset) {
        files.require(id,false);
        if (!asset.matches("(?:master|360|720)\\.m3u8|(?:360|720)-[0-9]{5}\\.ts")) throw new ApiException(ErrorCode.NOT_FOUND);
        var derivative=mapper.derivativeInfo(id,"HLS"); if (derivative==null) throw new ApiException(ErrorCode.NOT_FOUND);
        try {
            var metadata=json.readTree(mapper.hlsMetadata(id)); boolean allowed=false;
            for (var name:metadata.path("assets")) if (name.asText().equals(asset)) allowed=true;
            if (!allowed) throw new ApiException(ErrorCode.NOT_FOUND);
            String key=metadata.path("prefix").asText()+"/"+asset.replace('.','_');
            if (!objects.local(derivative.storageConfigId())) return ResponseEntity.status(302).location(java.net.URI.create(objects.downloadUrl(derivative.storageConfigId(),key))).build();
            return ResponseEntity.ok().contentType(MediaType.parseMediaType(asset.endsWith(".ts")?"video/mp2t":"application/vnd.apple.mpegurl"))
                    .header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff")
                    .body(new FileSystemResource(objects.path(derivative.storageConfigId(),key)));
        } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public ResponseEntity<?> derivative(UUID id,String kind) {
        files.require(id,false); var derivative=mapper.derivativeInfo(id,kind);
        if (derivative==null) throw new ApiException(ErrorCode.NOT_FOUND);
        if (!objects.local(derivative.storageConfigId())) return ResponseEntity.status(302).location(java.net.URI.create(objects.downloadUrl(derivative.storageConfigId(),derivative.storageKey()))).build();
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(derivative.mime())).header("X-Content-Type-Options","nosniff")
                .header("Cache-Control","private, no-store").body(new FileSystemResource(objects.path(derivative.storageConfigId(),derivative.storageKey())));
    }
    private void store(UUID id,com.ufm.generated.entity.FilesEntity file,String kind,Path output,String mime) throws Exception {
        String key=file.getProjectId()+"/derivatives/"+UUID.randomUUID(); objects.put(file.getStorageConfigId(),key,output);
        publication.publish(file,kind,key,mime,Files.size(output),"{}",java.util.List.of(new com.ufm.file.FileMapper.ObjectRef(file.getStorageConfigId(),key)));
    }
}
