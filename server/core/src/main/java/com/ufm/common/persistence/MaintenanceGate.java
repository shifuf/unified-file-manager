package com.ufm.common.persistence;

import com.ufm.common.error.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.sql.*;

@Component
public class MaintenanceGate {
    private static final long KEY=0x55464d_52455354L;
    private final String url,user,password;
    private Connection sharedConnection;
    private int readers;
    private boolean writer;
    private final java.nio.file.Path recoveryMarker;
    public MaintenanceGate(@Value("${spring.datasource.url}") String url,
                           @Value("${spring.datasource.username}") String user,
                           @Value("${spring.datasource.password}") String password,
                           @Value("${ufm.backup.path:${java.io.tmpdir}/ufm-backups}") String backupPath) {
        this.url=url; this.user=user; this.password=password;
        recoveryMarker=java.nio.file.Path.of(backupPath).toAbsolutePath().normalize().resolve("restore-incomplete");
    }
    public interface Lease extends AutoCloseable { @Override void close(); }
    public synchronized Lease shared() {
        if (writer || recovering()) throw new ApiException(ErrorCode.SERVICE_UNAVAILABLE);
        try {
            if (readers==0) sharedConnection=open(false);
            else if (!sharedConnection.isValid(1)) throw new ApiException(ErrorCode.SERVICE_UNAVAILABLE);
        } catch (SQLException ex) { throw new ApiException(ErrorCode.SERVICE_UNAVAILABLE); }
        readers++;
        java.util.concurrent.atomic.AtomicBoolean closed=new java.util.concurrent.atomic.AtomicBoolean();
        return ()->{ if (closed.compareAndSet(false,true)) synchronized (this) {
            if (--readers==0) { close(sharedConnection); sharedConnection=null; }
        } };
    }
    public synchronized Lease exclusive() {
        if (writer || readers>0) throw new ApiException(ErrorCode.SERVICE_UNAVAILABLE);
        Connection connection=open(true); writer=true;
        java.util.concurrent.atomic.AtomicBoolean closed=new java.util.concurrent.atomic.AtomicBoolean();
        return ()->{ if (closed.compareAndSet(false,true)) synchronized (this) { close(connection); writer=false; } };
    }
    private Connection open(boolean exclusive) {
        Connection connection=null;
        try {
            // Dedicated session: never exhaust the transaction pool while holding its lock.
            connection=DriverManager.getConnection(url,user,password);
            try (PreparedStatement statement=connection.prepareStatement(exclusive?
                    "SELECT pg_try_advisory_lock(?)":"SELECT pg_try_advisory_lock_shared(?)")) {
                statement.setLong(1,KEY);
                try (ResultSet result=statement.executeQuery()) {
                    if (!result.next() || !result.getBoolean(1)) throw new ApiException(ErrorCode.SERVICE_UNAVAILABLE);
                }
            }
            return connection;
        } catch (SQLException | RuntimeException ex) {
            if (connection!=null) try { connection.close(); } catch (SQLException ignored) {}
            if (ex instanceof ApiException api) throw api;
            throw new ApiException(ErrorCode.SERVICE_UNAVAILABLE);
        }
    }
    private void close(Connection connection) { if (connection!=null) try { connection.close(); } catch (SQLException ignored) {} }
    public boolean recovering() { return java.nio.file.Files.exists(recoveryMarker); }
    public void beginRestore() throws java.io.IOException {
        java.nio.file.Files.createDirectories(recoveryMarker.getParent());
        java.nio.file.Files.writeString(recoveryMarker,"Recovery incomplete; do not remove before verifying database and objects.\n");
    }
    public void finishRestore() throws java.io.IOException { java.nio.file.Files.deleteIfExists(recoveryMarker); }
}
