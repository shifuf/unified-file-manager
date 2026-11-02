package com.ufm.share;

import com.ufm.common.error.*;
import com.ufm.project.ProjectService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
public class DistributionController {
    private final DirectLinkService links;
    private final DownloadLedgerMapper ledger;
    private final ProjectService projects;
    public DistributionController(DirectLinkService links,DownloadLedgerMapper ledger,ProjectService projects) {
        this.links=links; this.ledger=ledger; this.projects=projects;
    }
    @GetMapping("/api/files/{id}/direct-link") public Map<String,String> link(@PathVariable UUID id,
            @RequestParam(defaultValue="3600") int ttl,HttpServletRequest request) { return links.link(id,ttl,request); }
    @GetMapping("/d/{id}") public ResponseEntity<?> download(@PathVariable UUID id,@RequestParam long exp,
            @RequestParam String sig,HttpServletRequest request) { return links.download(id,exp,sig,request); }
    @PostMapping("/api/ip-stats/ban") @ResponseStatus(HttpStatus.CREATED)
    public void ban(@Valid @RequestBody ShareDtos.Ban input) {
        if (!input.ip().matches("[0-9a-fA-F:.]{2,64}") || (!input.permanent() && input.until()==null)) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        ledger.ban(input);
    }
    @DeleteMapping("/api/ip-stats/ban") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void unban(@RequestParam String ip) { ledger.unban(ip); }
    @GetMapping("/api/ip-stats") public Map<String,Object> bans() { return Map.of("items",ledger.bans()); }
    @GetMapping("/api/download-stats/summary") public Map<String,Object> summary(@RequestParam UUID projectId) {
        projects.require(projectId); return ledger.summary(projectId);
    }
    @GetMapping("/api/download-stats/daily") public Map<String,Object> daily(@RequestParam UUID projectId) {
        projects.require(projectId); return Map.of("items",ledger.dailyStats(projectId));
    }
}
