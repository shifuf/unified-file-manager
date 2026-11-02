package com.ufm.project;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/projects")
public class ProjectController {
    private final ProjectService service;
    public ProjectController(ProjectService service) { this.service=service; }
    @GetMapping public Map<String,Object> list() { return Map.of("items",service.list()); }
    @PostMapping @ResponseStatus(HttpStatus.CREATED)
    public ProjectDtos.Created create(@Valid @RequestBody ProjectDtos.Input input) { return service.create(input); }
    @GetMapping("/{id}") public ProjectDtos.View get(@PathVariable UUID id) { return service.get(id); }
    @PostMapping("/{id}/secrets/rotate") public Map<String,String> rotate(@PathVariable UUID id) { return service.rotate(id); }
    @PatchMapping("/{id}") public ProjectDtos.View update(@PathVariable UUID id,@Valid @RequestBody ProjectDtos.Input input) {
        return service.update(id,input);
    }
    @DeleteMapping("/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) { service.delete(id); }
    @GetMapping("/{id}/storage-bindings") public Map<String,Object> bindings(@PathVariable UUID id) {
        return Map.of("items",service.bindings(id));
    }
    @PostMapping("/{id}/storage-bindings") @ResponseStatus(HttpStatus.CREATED)
    public ProjectDtos.Binding bind(@PathVariable UUID id,@Valid @RequestBody ProjectDtos.BindingInput input) {
        return service.bind(id,input.configId(),input.activate());
    }
    @PostMapping("/{id}/storage-bindings/{configId}/activate")
    public ProjectDtos.Binding activate(@PathVariable UUID id,@PathVariable UUID configId) {
        return service.bind(id,configId,true);
    }
}
