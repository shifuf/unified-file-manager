package com.ufm.common.config;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
public class ReadinessController {
    private final JdbcTemplate jdbc;
    private final com.ufm.common.persistence.MaintenanceGate gate;
    public ReadinessController(JdbcTemplate jdbc,com.ufm.common.persistence.MaintenanceGate gate) { this.jdbc=jdbc; this.gate=gate; }
    @GetMapping("/api/healthz")
    public ResponseEntity<Map<String,String>> health() {
        try {
            if (gate.recovering()) return ResponseEntity.status(503).body(Map.of("status","DOWN"));
            jdbc.queryForObject("SELECT 1",Integer.class);
            return ResponseEntity.ok(Map.of("status","UP"));
        } catch (org.springframework.dao.DataAccessException ex) {
            return ResponseEntity.status(503).body(Map.of("status","DOWN"));
        }
    }
}
