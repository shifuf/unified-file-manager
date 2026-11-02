package com.ufm.storage;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/storages")
public class StorageController {
    private final StorageService service;
    public StorageController(StorageService service) { this.service=service; }
    @GetMapping public Map<String,Object> list() { return Map.of("items",service.list()); }
    @GetMapping("/{id}") public StorageDtos.View get(@PathVariable UUID id) { return service.get(id); }
    @GetMapping("/{id}/configuration") public StorageDtos.View configuration(@PathVariable UUID id) { return service.configuration(id); }
    @PostMapping @ResponseStatus(HttpStatus.CREATED)
    public StorageDtos.View create(@Valid @RequestBody StorageDtos.Input input) { return service.create(input); }
    @PutMapping("/{id}/policy") public StorageDtos.Policy policy(@PathVariable UUID id,@Valid @RequestBody StorageDtos.Policy input) { return service.policy(id,input); }
    @GetMapping("/{id}/policy") public StorageDtos.Policy policy(@PathVariable UUID id) { return service.policy(id); }
    @PatchMapping("/{id}") public StorageDtos.View update(@PathVariable UUID id,@Valid @RequestBody StorageDtos.Edit input) {
        return service.update(id,input);
    }
    @DeleteMapping("/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) { service.delete(id); }
    @PostMapping("/{id}/test") public StorageDtos.Probe test(@PathVariable UUID id) { return service.probe(id); }
    @PostMapping("/test-draft") public StorageDtos.Probe draft(@Valid @RequestBody StorageDtos.Input input) {
        return service.probeDraft(input);
    }
    @GetMapping("/{id}/usage") public Map<String,Object> usage(@PathVariable UUID id) { return service.usage(id); }
    @PostMapping("/{id}/make-default") public StorageDtos.View makeDefault(@PathVariable UUID id) { return service.makeDefault(id); }
}
