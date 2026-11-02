package com.ufm.share;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.error.*;
import com.ufm.file.FilePaths;
import com.ufm.file.UploadMapper;
import com.ufm.project.ProjectService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
public class PublicationController {
    private final ShareMapper mapper;
    private final ProjectService projects;
    private final UploadMapper settings;
    private final ObjectMapper json;
    public PublicationController(ShareMapper mapper,ProjectService projects,UploadMapper settings,ObjectMapper json) {
        this.mapper=mapper; this.projects=projects; this.settings=settings; this.json=json;
    }
    @io.swagger.v3.oas.annotations.media.Schema(name="PublicationPublication")
    public record Publication(@NotNull UUID projectId,@NotBlank String folderPath,boolean isPublic) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="PublicationBrand")
    public record Brand(@Size(max=128) String title,@Size(max=256) String subtitle,@Size(max=256) String footer,boolean poweredBy,
                        @Size(max=262144) String logo,@Pattern(regexp="bg|bg-soft") String pageBackground,
                        @Pattern(regexp="surface|surface-2") String cardBackground) {}
    @PutMapping("/api/folder-public") public Map<String,Object> publish(@Valid @RequestBody Publication input) {
        projects.require(input.projectId()); mapper.publish(input.projectId(),FilePaths.folder(input.folderPath()),input.isPublic());
        return Map.of("items",mapper.policies(input.projectId()));
    }
    @GetMapping("/api/folder-public") public Map<String,Object> policies(@RequestParam UUID projectId) {
        projects.require(projectId); return Map.of("items",mapper.policies(projectId));
    }
    @DeleteMapping("/api/folder-public") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void remove(@RequestParam UUID projectId,@RequestParam String folderPath) {
        projects.require(projectId); mapper.unpublish(projectId,FilePaths.folder(folderPath));
    }
    @PatchMapping("/api/settings/share-brand") public Brand brand(@Valid @RequestBody Brand brand) {
        if (brand.logo()!=null && !brand.logo().isEmpty()) {
            if (!brand.logo().matches("data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*")) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
            try {
                byte[] bytes=Base64.getDecoder().decode(brand.logo().substring(brand.logo().indexOf(',')+1));
                try (var input=javax.imageio.ImageIO.createImageInputStream(new java.io.ByteArrayInputStream(bytes))) {
                    var readers=javax.imageio.ImageIO.getImageReaders(input);
                    if (!readers.hasNext()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
                    var reader=readers.next();
                    try { reader.setInput(input,true,true); if (reader.getWidth(0)>2048 || reader.getHeight(0)>2048) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE); }
                    finally { reader.dispose(); }
                }
            } catch (java.io.IOException | IllegalArgumentException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
        }
        try { settings.save("share.brand",json.writeValueAsString(brand)); return brand; }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    @GetMapping("/api/public/brand") public Brand brand() {
        String encoded=settings.read("share.brand");
        if (encoded==null) return new Brand("","","",true,"","bg","surface");
        try { return json.readValue(encoded,Brand.class); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
}
