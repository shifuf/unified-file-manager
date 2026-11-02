package com.ufm.storage;

import org.apache.http.impl.client.*;
import org.apache.http.impl.conn.PoolingHttpClientConnectionManager;
import org.apache.http.config.RegistryBuilder;
import org.apache.http.conn.socket.*;
import org.apache.http.conn.ssl.SSLConnectionSocketFactory;
import org.apache.http.client.config.RequestConfig;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.entity.ByteArrayEntity;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.util.Map;

@Component
public class SafeHttp {
    private final boolean allowPrivate;
    public SafeHttp(@Value("${ufm.outbound.allow-private-endpoints:false}") boolean allowPrivate) { this.allowPrivate=allowPrivate; }
    public void validate(String endpoint) { SafeEndpoint.validate(endpoint,allowPrivate); }
    public int post(String endpoint,byte[] body,Map<String,String> headers) throws Exception {
        var uri=SafeEndpoint.validate(endpoint,allowPrivate);
        var registry=RegistryBuilder.<ConnectionSocketFactory>create().register("http",PlainConnectionSocketFactory.getSocketFactory())
                .register("https",SSLConnectionSocketFactory.getSocketFactory()).build();
        var manager=allowPrivate?new PoolingHttpClientConnectionManager(registry):new PoolingHttpClientConnectionManager(registry,new PublicDnsResolver());
        manager.setMaxTotal(2); manager.setDefaultMaxPerRoute(2);
        try (var client=HttpClients.custom().setConnectionManager(manager).disableRedirectHandling().disableAutomaticRetries()
                .setDefaultRequestConfig(RequestConfig.custom().setConnectTimeout(5000).setSocketTimeout(10000).setConnectionRequestTimeout(5000).build()).build()) {
            HttpPost request=new HttpPost(uri); request.setHeader("Content-Type","application/json"); headers.forEach(request::setHeader);
            request.setEntity(new ByteArrayEntity(body));
            try (var response=client.execute(request)) { return response.getStatusLine().getStatusCode(); }
        }
    }
}
