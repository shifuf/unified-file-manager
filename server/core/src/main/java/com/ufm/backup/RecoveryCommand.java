package com.ufm.backup;

import com.ufm.common.error.*;
import org.springframework.stereotype.Service;
import java.util.UUID;

@Service
public class RecoveryCommand {
    private final BackupService backups;
    public RecoveryCommand(BackupService backups) { this.backups=backups; }
    public void execute(UUID id,String confirmation) throws Exception {
        if (!"RESTORE".equals(confirmation)) throw new ApiException(ErrorCode.CONFLICT);
        backups.executeRestore(id);
    }
    public static void main(String[] args) {
        if (args.length!=2 || !"RESTORE".equals(args[1])) {
            System.err.println("Usage: RecoveryCommand <backup-uuid> RESTORE"); System.exit(64);
        }
        UUID id;
        try { id=UUID.fromString(args[0]); }
        catch (IllegalArgumentException ex) { System.err.println("Invalid backup UUID"); System.exit(64); return; }
        // No HTTP server, schedulers or automatic Flyway upgrade during offline recovery.
        var app=new org.springframework.boot.SpringApplication(RecoveryConfiguration.class);
        app.setWebApplicationType(org.springframework.boot.WebApplicationType.NONE);
        app.setAdditionalProfiles("recovery");
        app.setDefaultProperties(java.util.Map.of("spring.flyway.enabled","false"));
        try (var context=app.run("--spring.flyway.enabled=false")) {
            context.getBean(RecoveryCommand.class).execute(id,args[1]);
            System.out.println("Verified archive restored; recovery marker cleared after all objects completed.");
        } catch (Exception ex) {
            System.err.println("Recovery failed; keep traffic stopped and inspect diagnostics. Do not remove recovery marker.");
            System.exit(1);
        }
    }
}
