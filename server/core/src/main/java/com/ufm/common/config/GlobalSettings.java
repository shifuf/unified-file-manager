package com.ufm.common.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.error.*;
import com.ufm.file.UploadMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.constraints.*;
import org.springframework.stereotype.Service;
import java.net.URI;
import java.util.*;

@Service
public class GlobalSettings {
    private final UploadMapper settings;
    private final ObjectMapper json;
    public GlobalSettings(UploadMapper settings,ObjectMapper json) { this.settings=settings; this.json=json; }
    @io.swagger.v3.oas.annotations.media.Schema(name="GlobalSettings")
    public record Values(@Min(1) @Max(5368709120L) long maxFileBytes,@Min(1) @Max(1000) int maxUploadFiles,
                         @Min(1) @Max(36500) int recycleDays,boolean forceHttps,
                         @NotNull @Size(max=100) List<@NotBlank @Size(max=253) String> allowedDomains,
                         @NotNull @Size(max=2048) String officePreviewUrl,@NotNull @Size(max=2048) String downloadDomain) {}
    public Values get() {
        String value=settings.read("global");
        if (value==null) return new Values(UploadLimits.MAX_FILE_BYTES,100,30,false,List.of(),"","");
        try { return json.readValue(value,Values.class); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public Values put(Values input) {
        for (String domain:input.allowedDomains()) if (!domain.matches("(?i)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?") || domain.contains(".."))
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        if (!input.officePreviewUrl().isEmpty()) origin(input.officePreviewUrl(),true);
        if (!input.downloadDomain().isEmpty()) origin(input.downloadDomain(),false);
        var normalized=new Values(input.maxFileBytes(),input.maxUploadFiles(),input.recycleDays(),input.forceHttps(),
                input.allowedDomains().stream().map(value->value.toLowerCase(Locale.ROOT)).distinct().toList(),input.officePreviewUrl(),input.downloadDomain());
        try { settings.save("global",json.writeValueAsString(normalized)); return normalized; }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public void uploadSize(long bytes) { if (bytes<0 || bytes>get().maxFileBytes()) throw new ApiException(ErrorCode.PAYLOAD_TOO_LARGE); }
    public void publicRequest(HttpServletRequest request,List<String> projectDomains) {
        String source=request.getHeader("Origin"); if (source==null) source=request.getHeader("Referer");
        String host=null;
        try { if (source!=null) { URI uri=URI.create(source); if (http(uri) && uri.getUserInfo()==null) host=uri.getHost(); } }
        catch (IllegalArgumentException ignored) {}
        final String normalizedHost=host;
        for (var allowed:List.of(get().allowedDomains(),projectDomains))
            if (!allowed.isEmpty() && (normalizedHost==null || allowed.stream().noneMatch(value->value.equalsIgnoreCase(normalizedHost))))
                throw new ApiException(ErrorCode.FORBIDDEN);
    }
    public String origin(String value,boolean allowPath) {
        try {
            URI uri=URI.create(value);
            if (!http(uri) || uri.getHost()==null || uri.getUserInfo()!=null || uri.getQuery()!=null
                    || uri.getFragment()!=null || (!allowPath && !uri.getPath().isEmpty() && !uri.getPath().equals("/")))
                throw new IllegalArgumentException();
            return value.replaceAll("/+$","");
        } catch (IllegalArgumentException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    }
    private boolean http(URI uri) { return "http".equals(uri.getScheme()) || "https".equals(uri.getScheme()); }
}
