package com.ufm.backup;

@org.springframework.context.annotation.Configuration
@org.springframework.context.annotation.Profile("recovery")
@org.springframework.boot.autoconfigure.EnableAutoConfiguration
@org.springframework.context.annotation.Import({RecoveryCommand.class,BackupService.class,com.ufm.task.TaskService.class,
        com.ufm.project.ProjectService.class,com.ufm.storage.StorageService.class,com.ufm.storage.ObjectStore.class,
        com.ufm.storage.LocalObjects.class,com.ufm.storage.S3Objects.class,com.ufm.storage.OssObjects.class,
        com.ufm.storage.QiniuObjects.class,com.ufm.storage.UpyunObjects.class,com.ufm.common.persistence.MaintenanceGate.class})
@org.mybatis.spring.annotation.MapperScan(basePackages="com.ufm",annotationClass=org.apache.ibatis.annotations.Mapper.class)
@org.springframework.boot.context.properties.EnableConfigurationProperties({com.ufm.common.config.UfmCryptoProperties.class})
public class RecoveryConfiguration {
    @org.springframework.context.annotation.Bean
    com.ufm.common.crypto.SecretCipher recoveryCipher(com.ufm.common.config.UfmCryptoProperties properties) {
        return new com.ufm.common.crypto.SecretCipher(properties.getKey());
    }
}
