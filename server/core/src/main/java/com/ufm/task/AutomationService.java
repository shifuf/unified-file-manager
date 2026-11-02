package com.ufm.task;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.Map;

@Service
public class AutomationService {
    private final AutomationMapper mapper;
    private final LifecycleService lifecycle;
    private final TaskService tasks;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.backup.RemoteBackupService remote;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.backup.BackupService backups;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.audit.AuditService audit;
    public AutomationService(AutomationMapper mapper,LifecycleService lifecycle,TaskService tasks) { this.mapper=mapper; this.lifecycle=lifecycle; this.tasks=tasks; }
    @Transactional
    public void tick() {
        if (mapper.claimWindow("automation.maintenance",3600)==1) tasks.enqueue(null,"MAINTENANCE",Map.of());
        if (remote.enabled() && java.time.ZonedDateTime.now(java.time.ZoneOffset.UTC).getHour()>=remote.hourUtc()
                && mapper.claimDay("automation.remote-backup",java.time.LocalDate.now(java.time.ZoneOffset.UTC).toString())==1) backups.create(true);
        for (var policy:lifecycle.list()) if (policy.enabled() && mapper.claimWindow("automation.lifecycle."+policy.id(),86400)==1)
            lifecycle.run(policy.id());
    }
    public void cleanExpired() { mapper.rates(); mapper.nonces(); mapper.credentials(); audit.cleanup(); }
}
