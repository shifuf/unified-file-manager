package com.ufm.notify;

import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;
import java.util.*;

@RestController
@RequestMapping("/api/notify-channels")
public class NotifyController {
    private final NotifyService service;
    public NotifyController(NotifyService service) { this.service=service; }
    @GetMapping public Map<String,Object> list() { return Map.of("items",service.list()); }
    @PostMapping @ResponseStatus(HttpStatus.CREATED) public NotifyService.View create(@Valid @RequestBody NotifyService.Input input) { return service.create(input); }
    @GetMapping("/{id}/configuration") public NotifyService.Configuration configuration(@PathVariable UUID id) { return service.configuration(id); }
    @PatchMapping("/{id}") public NotifyService.View edit(@PathVariable UUID id,@Valid @RequestBody NotifyService.Edit input) { return service.edit(id,input); }
    @DeleteMapping("/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void delete(@PathVariable UUID id) { service.delete(id); }
    @PostMapping("/{id}/test") @ResponseStatus(HttpStatus.ACCEPTED) public void test(@PathVariable UUID id) { service.test(id); }
    @GetMapping("/{id}/deliveries") public Map<String,Object> deliveries(@PathVariable UUID id) { return Map.of("items",service.deliveries(id)); }
}
