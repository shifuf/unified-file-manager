package com.ufm.common.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.error.*;
import com.ufm.file.UploadMapper;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/settings")
public class DisplayPreferencesController {
    private static final List<String> CARDS=List.of("recent","notifications","projects","shares","folders","storages","trend");
    private static final List<String> ACTIONS=List.of("download","details","share","recycle");
    private final UploadMapper settings;
    private final ObjectMapper json;
    public DisplayPreferencesController(UploadMapper settings,ObjectMapper json) { this.settings=settings; this.json=json; }
    @io.swagger.v3.oas.annotations.media.Schema(name="DisplayPreferences")
    public record Preferences(@NotNull @Size(max=10) List<@NotBlank String> items) {}
    @GetMapping("/{kind:workbench|hover-actions}") public Preferences get(@PathVariable String kind) {
        String value=settings.manifest(key(kind));
        if (value==null) return new Preferences(allowed(kind));
        try { return json.readValue(value,Preferences.class); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    @PutMapping("/{kind:workbench|hover-actions}") public Preferences put(@PathVariable String kind,@Valid @RequestBody Preferences input) {
        if (!allowed(kind).containsAll(input.items()) || new HashSet<>(input.items()).size()!=input.items().size())
            throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        try { settings.save(key(kind),json.writeValueAsString(input)); return input; }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private String key(String kind) { return kind.equals("workbench")?"workbench":"hover_actions"; }
    private List<String> allowed(String kind) { return kind.equals("workbench")?CARDS:ACTIONS; }
}
