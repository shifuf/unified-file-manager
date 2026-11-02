package com.ufm.task;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/lifecycle")
public class LifecycleController {
    private final LifecycleService service;
    public LifecycleController(LifecycleService service) { this.service=service; }
    @GetMapping public Map<String,Object> list() { return Map.of("items",service.list()); }
    @PostMapping @ResponseStatus(HttpStatus.CREATED)
    public LifecycleService.Policy create(@Valid @RequestBody LifecycleService.Input input) { return service.create(input); }
    @PutMapping("/{id}") public LifecycleService.Policy update(@PathVariable UUID id,@Valid @RequestBody LifecycleService.Input input) { return service.update(id,input); }
    @DeleteMapping("/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void delete(@PathVariable UUID id) { service.delete(id); }
    @PostMapping("/{id}/run") @ResponseStatus(HttpStatus.ACCEPTED) public void run(@PathVariable UUID id) { service.run(id); }
}
