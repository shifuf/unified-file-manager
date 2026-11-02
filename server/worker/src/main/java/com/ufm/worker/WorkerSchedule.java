package com.ufm.worker;

import com.ufm.task.TaskMapper;
import com.ufm.task.TaskRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.*;

@Configuration
@EnableScheduling
public class WorkerSchedule {
    private final TaskRunner runner;
    private final TaskMapper mapper;
    private final com.ufm.common.persistence.MaintenanceGate maintenance;
    private final com.ufm.task.AutomationService automation;
    public WorkerSchedule(TaskRunner runner,TaskMapper mapper,com.ufm.common.persistence.MaintenanceGate maintenance,com.ufm.task.AutomationService automation) { this.runner=runner; this.mapper=mapper; this.maintenance=maintenance; this.automation=automation; }
    @Scheduled(fixedDelayString="${ufm.worker.poll-ms:1000}") public void poll() { runner.runOne(); }
    @Scheduled(fixedDelay=30000) public void recover() {
        try (var lease=maintenance.shared()) { mapper.recover(); }
        catch (com.ufm.common.error.ApiException ex) { /* Restore owns the database; try again next tick. */ }
    }
    @Scheduled(fixedDelay=60000,initialDelay=60000) public void automate() {
        try (var lease=maintenance.shared()) { automation.tick(); }
        catch (com.ufm.common.error.ApiException ex) { /* Restore owns the database. */ }
    }
}
