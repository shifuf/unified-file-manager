package com.ufm.notify;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ufm.common.crypto.SecretCipher;
import com.ufm.common.error.*;
import com.ufm.project.ProjectService;
import com.ufm.storage.SafeHttp;
import com.ufm.task.TaskService;
import jakarta.validation.constraints.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import java.nio.charset.StandardCharsets;

@Service
public class NotifyService {
    private final NotifyMapper mapper;
    private final TaskService tasks;
    private final SecretCipher cipher;
    private final SafeHttp http;
    private final ObjectMapper json;
    private final ProjectService projects;
    @org.springframework.beans.factory.annotation.Autowired private NotificationMapper inbox;
    public NotifyService(NotifyMapper mapper,TaskService tasks,SecretCipher cipher,SafeHttp http,ObjectMapper json,ProjectService projects) { this.mapper=mapper; this.tasks=tasks; this.cipher=cipher; this.http=http; this.json=json; this.projects=projects; }
    @io.swagger.v3.oas.annotations.media.Schema(name="NotifyInput")
    public record Input(UUID projectId,@NotBlank @Size(max=128) String name,@Pattern(regexp="WEBHOOK|PUSH_PLATFORM") String type,
                        @NotBlank String endpoint,@NotBlank @Size(max=512) String secret,@Size(max=30) List<String> events,boolean enabled) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="NotifyView")
    public record View(UUID id,UUID projectId,String name,String type,boolean enabled,List<String> events) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="NotifyEdit")
    public record Edit(@Size(min=1,max=128) String name,@Size(min=1,max=2048) String endpoint,@Size(min=1,max=512) String secret,@Size(max=30) List<String> events,Boolean enabled) {}
    @io.swagger.v3.oas.annotations.media.Schema(name="NotifyConfiguration")
    public record Configuration(View channel,String endpoint) {}
    public Configuration configuration(UUID id) {
        var channel=require(id);
        try { return new Configuration(view(channel),json.readTree(cipher.decrypt(json.readTree(channel.config()).path("enc").asText())).path("endpoint").asText()); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    @Transactional public View edit(UUID id,Edit input) {
        var channel=require(id); String encoded=channel.config();
        try {
            if (input.endpoint()!=null || input.secret()!=null) {
                var previous=json.readTree(cipher.decrypt(json.readTree(encoded).path("enc").asText()));
                String endpoint=input.endpoint()==null?previous.path("endpoint").asText():input.endpoint(); http.validate(endpoint);
                encoded=json.writeValueAsString(Map.of("enc",cipher.encrypt(json.writeValueAsString(Map.of("endpoint",endpoint,"secret",input.secret()==null?previous.path("secret").asText():input.secret())))));
            }
            mapper.edit(id,input.name()==null?channel.name():input.name(),encoded,input.events()==null?channel.events():json.writeValueAsString(input.events()),input.enabled()==null?channel.enabled():input.enabled());
            return view(require(id));
        } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public List<View> list() { return mapper.channels().stream().map(this::view).toList(); }
    public View create(Input input) {
        if (input.projectId()!=null) projects.require(input.projectId()); http.validate(input.endpoint());
        UUID id=UUID.randomUUID();
        try { mapper.create(id,input.projectId(),input.name(),input.type(),json.writeValueAsString(Map.of("enc",cipher.encrypt(json.writeValueAsString(Map.of("endpoint",input.endpoint(),"secret",input.secret()))))),json.writeValueAsString(input.events()==null?List.of():input.events()),input.enabled()); return view(require(id)); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    public void delete(UUID id) { require(id); mapper.delete(id); }
    public List<NotifyMapper.Delivery> deliveries(UUID id) { require(id); return mapper.deliveries(id); }
    public void test(UUID id) { var channel=require(id); enqueue(channel,"TEST",Map.of("message","UFM connection test")); }
    @Transactional
    public void event(UUID project,String event,Object data) {
        event(project,event,data,false);
    }
    @Transactional
    public void failureEvent(UUID project,String event,Object data) {
        event(project,event,data,true);
    }
    private void event(UUID project,String event,Object data,boolean detached) {
        String[] notice=switch (event) {
            case "FILE_UPLOADED" -> new String[]{"文件上传","文件已上传，可进入文件空间查看。","/files"};
            case "FILE_DELETED" -> new String[]{"文件回收","文件已进入回收站。","/recycle"};
            case "SHARE_DOWNLOADED" -> new String[]{"分享下载","分享内容收到下载请求，请在分发统计查看成功输出。","/audit"};
            case "RATE_LIMITED" -> new String[]{"访问限流","访问频率超过限制，请查看 IP 台账。","/audit"};
            case "QUOTA_EXHAUSTED" -> new String[]{"项目配额不足","文件操作因空间或数量额度不足被拒绝。","/projects"};
            case "STORAGE_FAILED" -> new String[]{"存储异常","存储操作失败，请检查连通性与任务记录。","/storages"};
            default -> null;
        };
        if (notice!=null && (project==null || Boolean.TRUE.equals(projects.require(project).getNotifyEnabled()))) {
            mapper.aggregateLock("inbox."+Objects.toString(project,"")+"."+event);
            // Failure events survive rollback; no project FK lock against the suspended business transaction.
            UUID scope=detached?null:project;
            String href=notice[2]+(project==null?"":"?project="+project);
            UUID recent=inbox.recent(scope,notice[0],href);
            if (recent==null) inbox.emit(scope,notice[0],notice[1],href);
            else inbox.aggregate(recent,notice[1]+" 最近 30 秒内发生同类事件，请查看详情。");
        }
        for (var channel:mapper.channels()) if (channel.enabled() && (channel.projectId()==null || channel.projectId().equals(project)) && view(channel).events().contains(event)) {
            String scope=Objects.toString(project,"");
            mapper.aggregateLock("notify."+channel.id()+"."+event+"."+scope);
            UUID pending=mapper.aggregatePending(channel.id().toString(),event,scope);
            try {
                if (pending!=null) mapper.aggregate(pending,json.writeValueAsString(data));
                else {
                    var aggregated=json.valueToTree(data);
                    com.fasterxml.jackson.databind.node.ObjectNode node=aggregated.isObject()?(com.fasterxml.jackson.databind.node.ObjectNode)aggregated:json.createObjectNode();
                    if (!aggregated.isObject()) node.set("sample",aggregated);
                    node.set("aggregation",json.valueToTree(Map.of("count",1,"samples",List.of(data))));
                    mapper.aggregateCreate(json.writeValueAsString(Map.of("channelId",channel.id().toString(),"event",event,"aggregateProject",scope,"data",node)));
                }
            } catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        }
    }
    private void enqueue(NotifyMapper.Channel channel,String event,Object data) {
        if (!channel.enabled()) throw new ApiException(ErrorCode.CONFLICT);
        // Delivery scope is the channel; no project FK lock across failed business transactions.
        tasks.enqueue(null,"NOTIFY",Map.of("channelId",channel.id().toString(),"event",event,"data",data));
    }
    public void deliver(UUID id,String event,com.fasterxml.jackson.databind.JsonNode data) throws Exception {
        var channel=require(id); if (!channel.enabled()) return;
        var config=json.readTree(cipher.decrypt(json.readTree(channel.config()).path("enc").asText()));
        byte[] payload=json.writeValueAsBytes(Map.of("event",event,"data",data));
        var mac=javax.crypto.Mac.getInstance("HmacSHA256"); mac.init(new javax.crypto.spec.SecretKeySpec(config.path("secret").asText().getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
        Map<String,String> headers=new HashMap<>(); headers.put("x-ufm-signature","sha256="+HexFormat.of().formatHex(mac.doFinal(payload)));
        if (channel.type().equals("PUSH_PLATFORM")) headers.put("Authorization","Bearer "+config.path("secret").asText());
        Integer status=null;
        try { status=http.post(config.path("endpoint").asText(),payload,headers); mapper.delivery(id,event,status>=200 && status<300,status,status>=200 && status<300?null:"Remote endpoint rejected notification"); }
        catch (Exception ex) { mapper.delivery(id,event,false,null,"Outbound delivery failed"); throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        if (status<200 || status>=300) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
    }
    private NotifyMapper.Channel require(UUID id) { var row=mapper.get(id); if (row==null) throw new ApiException(ErrorCode.NOT_FOUND); return row; }
    private View view(NotifyMapper.Channel channel) {
        try { return new View(channel.id(),channel.projectId(),channel.name(),channel.type(),channel.enabled(),json.readValue(channel.events(),new com.fasterxml.jackson.core.type.TypeReference<List<String>>(){})); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
}
