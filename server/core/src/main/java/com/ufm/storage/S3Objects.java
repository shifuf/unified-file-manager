package com.ufm.storage;

import com.ufm.common.error.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.auth.credentials.*;
import software.amazon.awssdk.http.apache.ApacheHttpClient;
import software.amazon.awssdk.http.apache.ProxyConfiguration;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.*;
import software.amazon.awssdk.services.s3.model.*;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.*;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;

@Service
public class S3Objects {
    private final StorageService configs;
    private final boolean allowPrivate;
    public S3Objects(StorageService configs,@Value("${ufm.storage.allow-private-endpoints:false}") boolean allowPrivate) {
        this.configs=configs; this.allowPrivate=allowPrivate;
    }
    private Map<String,Object> config(UUID id) {
        if (!configs.requireEnabled(id).getProvider().equals("S3")) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        return configs.config(id);
    }
    private String value(Map<String,Object> config,String key) {
        Object v=config.get(key); if (!(v instanceof String s) || s.isBlank()) throw new ApiException(ErrorCode.INVALID_ARGUMENT);
        return s;
    }
    private S3Client client(Map<String,Object> c) {
        var transport=ApacheHttpClient.builder().connectionTimeout(Duration.ofSeconds(5)).socketTimeout(Duration.ofSeconds(30))
                .maxConnections(2).proxyConfiguration(ProxyConfiguration.builder().useSystemPropertyValues(false).useEnvironmentVariableValues(false).build());
        if (!allowPrivate) transport.dnsResolver(new PublicDnsResolver());
        return S3Client.builder().endpointOverride(SafeEndpoint.validate(value(c,"endpoint"),allowPrivate))
                .region(Region.of(value(c,"region"))).credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(value(c,"accessKey"),value(c,"secretKey"))))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .httpClientBuilder(transport)
                .overrideConfiguration(o->o.apiCallTimeout(Duration.ofSeconds(60)).apiCallAttemptTimeout(Duration.ofSeconds(30)))
                .build();
    }
    private S3Presigner presigner(Map<String,Object> c) {
        return S3Presigner.builder().endpointOverride(SafeEndpoint.validate(value(c,"endpoint"),allowPrivate))
                .region(Region.of(value(c,"region"))).credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(value(c,"accessKey"),value(c,"secretKey"))))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }
    public String putUrl(UUID id,String key,long size) {
        Map<String,Object> c=config(id);
        try (S3Presigner signer=presigner(c)) {
            return signer.presignPutObject(PutObjectPresignRequest.builder().signatureDuration(Duration.ofMinutes(15))
                    .putObjectRequest(PutObjectRequest.builder().bucket(value(c,"bucket")).key(key).contentLength(size).build()).build())
                    .url().toString();
        }
    }
    public StorageDtos.Probe probe(Map<String,Object> config) {
        long start=System.nanoTime(); String key="ufm-probe/"+UUID.randomUUID();
        byte[] expected=new byte[1024]; new java.security.SecureRandom().nextBytes(expected);
        try (S3Client client=client(config)) {
            String bucket=value(config,"bucket"); boolean attempted=false;
            try {
                attempted=true;
                client.putObject(PutObjectRequest.builder().bucket(bucket).key(key).build(),software.amazon.awssdk.core.sync.RequestBody.fromBytes(expected));
                byte[] actual=client.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key).build()).asByteArray();
                if (!java.security.MessageDigest.isEqual(expected,actual)) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
            } finally { if (attempted) client.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build()); }
            return new StorageDtos.Probe(true,(System.nanoTime()-start)/1_000_000);
        } catch (software.amazon.awssdk.core.exception.SdkException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public String getUrl(UUID id,String key) {
        Map<String,Object> c=config(id);
        try (S3Presigner signer=presigner(c)) {
            return signer.presignGetObject(GetObjectPresignRequest.builder().signatureDuration(Duration.ofMinutes(5))
                    .getObjectRequest(GetObjectRequest.builder().bucket(value(c,"bucket")).key(key)
                            .responseContentDisposition("attachment").build()).build()).url().toString();
        }
    }
    public long size(UUID id,String key) {
        Map<String,Object> c=config(id);
        try (S3Client client=client(c)) {
            return client.headObject(HeadObjectRequest.builder().bucket(value(c,"bucket")).key(key).build()).contentLength();
        } catch (S3Exception ex) {
            if (ex.statusCode()==404) return -1;
            throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        } catch (software.amazon.awssdk.core.exception.SdkException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void put(UUID id,String key,Path source) {
        Map<String,Object> c=config(id);
        try (S3Client client=client(c)) {
            client.putObject(PutObjectRequest.builder().bucket(value(c,"bucket")).key(key).build(),source);
        } catch (software.amazon.awssdk.core.exception.SdkException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public String seal(UUID id,String source,String target,long size) {
        Map<String,Object> c=config(id);
        try (S3Client client=client(c)) {
            String bucket=value(c,"bucket");
            var head=client.headObject(HeadObjectRequest.builder().bucket(bucket).key(source).build());
            if (head.contentLength()!=size) throw new ApiException(ErrorCode.CONFLICT);
            // Never publish the key authorized by a still-valid browser PUT URL.
            client.copyObject(CopyObjectRequest.builder().bucket(bucket).key(target).copySource(bucket+"/"+source)
                    .copySourceIfMatch(head.eTag()).build());
            if (client.headObject(HeadObjectRequest.builder().bucket(bucket).key(target).build()).contentLength()!=size)
                throw new ApiException(ErrorCode.CONFLICT);
            return target;
        } catch (S3Exception ex) {
            throw new ApiException(ex.statusCode()==412?ErrorCode.CONFLICT:ErrorCode.STORAGE_UNAVAILABLE);
        } catch (software.amazon.awssdk.core.exception.SdkException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void get(UUID id,String key,Path target) {
        Map<String,Object> c=config(id);
        try (S3Client client=client(c)) {
            client.getObject(GetObjectRequest.builder().bucket(value(c,"bucket")).key(key).build(),target);
        } catch (software.amazon.awssdk.core.exception.SdkException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public java.io.InputStream openRange(UUID id,String key,long start,long length) {
        Map<String,Object> c=config(id); S3Client client=client(c);
        try {
            var stream=client.getObject(GetObjectRequest.builder().bucket(value(c,"bucket")).key(key)
                    .range("bytes="+start+"-"+(start+length-1)).build());
            if (stream.response().contentLength()!=length) {
                stream.abort(); throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
            }
            return new java.io.FilterInputStream(stream) {
                @Override public void close() throws java.io.IOException {
                    try { stream.abort(); } finally { client.close(); }
                }
            };
        } catch (RuntimeException ex) {
            client.close();
            if (ex instanceof ApiException api) throw api;
            throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE);
        }
    }
    public void remove(UUID id,String key) {
        Map<String,Object> c=config(id);
        try (S3Client client=client(c)) { client.deleteObject(DeleteObjectRequest.builder().bucket(value(c,"bucket")).key(key).build()); }
        catch (software.amazon.awssdk.core.exception.SdkException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public String multipart(UUID id,String key) {
        Map<String,Object> c=config(id);
        try (S3Client client=client(c)) {
            return client.createMultipartUpload(CreateMultipartUploadRequest.builder().bucket(value(c,"bucket")).key(key).build()).uploadId();
        } catch (software.amazon.awssdk.core.exception.SdkException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public String partUrl(UUID id,String key,String uploadId,int part) {
        Map<String,Object> c=config(id);
        try (S3Presigner signer=presigner(c)) {
            return signer.presignUploadPart(UploadPartPresignRequest.builder().signatureDuration(Duration.ofMinutes(15))
                    .uploadPartRequest(UploadPartRequest.builder().bucket(value(c,"bucket")).key(key).uploadId(uploadId).partNumber(part).build())
                    .build()).url().toString();
        }
    }
    public void complete(UUID id,String key,String uploadId,List<CompletedPart> parts) {
        Map<String,Object> c=config(id);
        try (S3Client client=client(c)) {
            client.completeMultipartUpload(CompleteMultipartUploadRequest.builder().bucket(value(c,"bucket")).key(key).uploadId(uploadId)
                    .multipartUpload(CompletedMultipartUpload.builder().parts(parts).build()).build());
        } catch (software.amazon.awssdk.core.exception.SdkException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
    public void abort(UUID id,String key,String uploadId) {
        Map<String,Object> c=config(id);
        try (S3Client client=client(c)) {
            client.abortMultipartUpload(AbortMultipartUploadRequest.builder().bucket(value(c,"bucket")).key(key).uploadId(uploadId).build());
        } catch (S3Exception ex) { if (ex.statusCode()!=404) throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
        catch (software.amazon.awssdk.core.exception.SdkException ex) { throw new ApiException(ErrorCode.STORAGE_UNAVAILABLE); }
    }
}
