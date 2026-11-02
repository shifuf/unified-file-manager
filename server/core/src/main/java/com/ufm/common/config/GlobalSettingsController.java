package com.ufm.common.config;

import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/settings/global")
public class GlobalSettingsController {
    private final GlobalSettings settings;
    public GlobalSettingsController(GlobalSettings settings) { this.settings=settings; }
    @GetMapping public GlobalSettings.Values get() { return settings.get(); }
    @PutMapping public GlobalSettings.Values put(@Valid @RequestBody GlobalSettings.Values input) { return settings.put(input); }
}
