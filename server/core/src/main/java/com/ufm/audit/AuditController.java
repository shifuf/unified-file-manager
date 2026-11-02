package com.ufm.audit;

import com.ufm.common.error.*;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/audit-logs")
public class AuditController {
    private final AuditService audit;
    public AuditController(AuditService audit) { this.audit=audit; }
    @GetMapping("/retention") public AuditService.Retention retention() { return audit.retention(); }
    @PutMapping("/retention") public AuditService.Retention retention(@jakarta.validation.Valid @RequestBody AuditService.Retention input) { return audit.retention(input); }
    @PostMapping("/cleanup") public Map<String,Integer> cleanup() { return Map.of("deleted",audit.cleanup()); }
    @GetMapping public Map<String,Object> list(@RequestParam(defaultValue="") String action,@RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="100") int size) {
        validate(action,page,size); return Map.of("items",audit.list(action,size,(long)page*size),"total",audit.count(action));
    }
    @GetMapping("/export") public ResponseEntity<String> export(@RequestParam(defaultValue="") String action) {
        validate(action,0,100);
        StringBuilder csv=new StringBuilder("created_at,action,actor_id,project_id,ip,detail\r\n");
        for (var row:audit.list(action,10000,0)) csv.append(cell(row.createdAt())).append(',').append(cell(row.action())).append(',')
                .append(cell(row.actorId())).append(',').append(cell(row.projectId())).append(',').append(cell(row.ip())).append(',').append(cell(row.detail())).append("\r\n");
        return ResponseEntity.ok().header("Content-Disposition","attachment; filename=ufm-audit.csv").header("Cache-Control","no-store")
                .contentType(MediaType.parseMediaType("text/csv;charset=UTF-8")).body(csv.toString());
    }
    private void validate(String action,int page,int size) { if (action.length()>96 || page<0 || size<1 || size>200) throw new ApiException(ErrorCode.INVALID_ARGUMENT); }
    private String cell(Object value) {
        String text=Objects.toString(value,""); if (text.matches("^[\\s]*[=+@-].*")) text="'"+text;
        return "\""+text.replace("\"","\"\"")+"\"";
    }
}
