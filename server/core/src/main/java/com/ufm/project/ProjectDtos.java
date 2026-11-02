package com.ufm.project;

import jakarta.validation.constraints.*;
import java.util.*;

public final class ProjectDtos {
    private ProjectDtos() {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectInput")
    public record Input(@NotBlank @Size(max=128) String name,@Size(max=4096) String description,
                        @Min(0) long quotaBytes,@Min(0) long quotaFiles,
                        @Size(max=100) List<@Pattern(regexp="[A-Za-z0-9.-]{1,253}") String> allowedDomains) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectView")
    public record View(UUID id,String appId,String name,String description,long quotaBytes,long quotaFiles,
                       long usedBytes,long usedFiles,List<String> allowedDomains) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectCreated")
    public record Created(View project,String appSecret) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectBindingInput")
    public record BindingInput(@NotNull UUID configId,boolean activate) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="ProjectBinding")
    public record Binding(UUID id,UUID projectId,UUID configId,boolean isActive,int priority) {}
}
