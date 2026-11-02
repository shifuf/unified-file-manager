package com.ufm.project;

import org.springframework.web.bind.annotation.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

@RestController
@RequestMapping("/api/projects/{id}/notification-settings")
public class ProjectNotificationController {
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectNotificationSettings")
    public record Settings(@NotNull Boolean enabled) {}
    private final ProjectService projects;
    private final ProjectMapper mapper;
    public ProjectNotificationController(ProjectService projects,ProjectMapper mapper) { this.projects=projects; this.mapper=mapper; }
    @GetMapping public Settings get(@PathVariable UUID id) { return new Settings(Boolean.TRUE.equals(projects.require(id).getNotifyEnabled())); }
    @PutMapping public Settings put(@PathVariable UUID id,@Valid @RequestBody Settings input) {
        projects.require(id); mapper.notifications(id,input.enabled()); return input;
    }
}
