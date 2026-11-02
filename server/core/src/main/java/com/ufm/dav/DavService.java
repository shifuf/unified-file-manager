package com.ufm.dav;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.auth.AuthService;
import com.ufm.auth.PasswordPolicy;
import com.ufm.common.error.*;
import com.ufm.file.UploadMapper;
import com.ufm.project.ProjectService;
import jakarta.validation.constraints.*;
import org.apache.ibatis.annotations.*;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.*;

@Service
public class DavService {
    public record Principal(UUID projectId) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DavSettingsInput")
    public record Input(boolean enabled,@NotBlank @Pattern(regexp="[A-Za-z0-9_.-]{3,64}") String username,@Size(max=72) String password) {}
    public record Config(boolean enabled,String username,String passwordHash) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="DavSettingsView")
    public record View(boolean enabled,String username) {}
    public record Lock(String token,String path,OffsetDateTime expiresAt) {}
    @Mapper public interface Queries {
        @Select("SELECT token,path,expires_at FROM dav_locks WHERE project_id=#{project} AND expires_at>now() ORDER BY path") List<Lock> locks(UUID project);
        @Insert("INSERT INTO dav_locks(project_id,path,token,expires_at) VALUES(#{project},#{path},#{token},now()+#{seconds}*interval '1 second')") int lock(UUID project,String path,String token,int seconds);
        @Delete("DELETE FROM dav_locks WHERE project_id=#{project} AND path=#{path} AND token=#{token}") int unlock(UUID project,String path,String token);
        @Delete("DELETE FROM dav_locks WHERE expires_at<=now()") int expired();
        @Select("SELECT id FROM files WHERE project_id=#{project} AND folder_path=#{folder} AND original_name=#{name} AND status='ACTIVE' AND deleted_at IS NULL") UUID file(UUID project,String folder,String name);
        @Select("SELECT id FROM files WHERE project_id=#{project} AND starts_with(folder_path,#{folder}) AND status='ACTIVE' AND deleted_at IS NULL ORDER BY id LIMIT 200") List<UUID> children(UUID project,String folder);
        @Select("SELECT id FROM files WHERE project_id=#{project} AND starts_with(folder_path,#{folder}) AND status='ACTIVE' AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET #{offset}") List<UUID> copyBatch(UUID project,String folder,long offset);
        @Update("UPDATE folders SET deleted_at=now() WHERE project_id=#{project} AND starts_with(path,#{folder})") int removeFolders(UUID project,String folder);
    }
    private final UploadMapper settings;
    private final Queries queries;
    private final ProjectService projects;
    private final PasswordEncoder passwords;
    private final ObjectMapper json;
    @org.springframework.beans.factory.annotation.Autowired private com.ufm.auth.LoginRateMapper rates;
    public DavService(UploadMapper settings,Queries queries,ProjectService projects,PasswordEncoder passwords,ObjectMapper json) { this.settings=settings; this.queries=queries; this.projects=projects; this.passwords=passwords; this.json=json; }
    public View get(UUID project) { projects.require(project); var config=config(project); return new View(config.enabled(),config.username()); }
    @Transactional public View save(UUID project,Input input) {
        projects.require(project); Config previous=config(project); String hash=previous.passwordHash();
        if (input.password()!=null && !input.password().isEmpty()) {
            if (!PasswordPolicy.violations(input.password()).isEmpty()) throw new ApiException(ErrorCode.VALIDATION_FAILED);
            hash=passwords.encode(input.password());
        }
        if (input.enabled() && hash==null) throw new ApiException(ErrorCode.VALIDATION_FAILED);
        try { settings.save("dav."+project,json.writeValueAsString(new Config(input.enabled(),input.username(),hash))); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        return new View(input.enabled(),input.username());
    }
    private Config config(UUID project) {
        String value=settings.manifest("dav."+project); if (value==null) return new Config(false,"",null);
        try { return json.readValue(value,Config.class); } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public Principal authenticate(String uri,String authorization,String ip) {
        UUID project;
        try { project=UUID.fromString(uri.split("/",4)[2]); } catch (RuntimeException ex) { throw new ApiException(ErrorCode.UNAUTHORIZED); }
        String user="",password="";
        try {
            if (authorization==null || !authorization.startsWith("Basic ") || authorization.length()>512) throw new IllegalArgumentException();
            String[] pair=new String(Base64.getDecoder().decode(authorization.substring(6)),StandardCharsets.UTF_8).split(":",2);
            user=pair[0]; password=pair[1];
        } catch (RuntimeException ex) { throw new ApiException(ErrorCode.UNAUTHORIZED); }
        Config config=config(project);
        boolean valid=config.enabled() && config.username().equals(user) && config.passwordHash()!=null && passwords.matches(password,config.passwordHash());
        if (!valid) {
            if (rates.increment("auth.rate.dav."+AuthService.hash(ip+":"+project),300)>10) throw new ApiException(ErrorCode.RATE_LIMITED);
            throw new ApiException(ErrorCode.UNAUTHORIZED);
        }
        projects.require(project); return new Principal(project);
    }
    public void checkLock(UUID project,String path,String supplied) {
        for (var lock:queries.locks(project)) {
            String locked=lock.path(),directory=locked.endsWith("/")?locked:locked+"/";
            if (path.equals(locked) || path.startsWith(directory) || locked.startsWith(path.endsWith("/")?path:path+"/"))
                if (supplied==null || !supplied.contains("<"+lock.token()+">")) throw new ApiException(ErrorCode.CONFLICT,"Resource locked",null,HttpStatus.LOCKED);
        }
    }
    public String lock(UUID project,String path,String supplied,int seconds) {
        queries.expired(); checkLock(project,path,supplied);
        if (supplied!=null) for (var lock:queries.locks(project)) if (lock.path().equals(path) && supplied.contains("<"+lock.token()+">")) {
            queries.unlock(project,path,lock.token()); queries.lock(project,path,lock.token(),seconds); return lock.token();
        }
        String token="opaquelocktoken:"+UUID.randomUUID(); queries.lock(project,path,token,seconds); return token;
    }
    public void unlock(UUID project,String path,String token) {
        if (token==null || queries.unlock(project,path,token.replace("<","").replace(">",""))!=1) throw new ApiException(ErrorCode.CONFLICT);
    }
}
