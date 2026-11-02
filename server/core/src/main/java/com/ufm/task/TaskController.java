package com.ufm.task;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/tasks")
public class TaskController {
    private final TaskService service;
    public TaskController(TaskService service) { this.service=service; }
    @GetMapping public Map<String,Object> list() { return Map.of("items",service.list()); }
    @GetMapping("/{id}") public TaskService.View get(@PathVariable UUID id) { return service.get(id); }
    @PostMapping("/migrations") @ResponseStatus(HttpStatus.CREATED)
    public TaskService.View migration(@Valid @RequestBody TaskService.Migration input) { return service.migration(input); }
    @PostMapping("/{id}/{action:pause|resume|cancel|retry}")
    public TaskService.View action(@PathVariable UUID id,@PathVariable String action) { return service.action(id,action); }
}
