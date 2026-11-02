package com.ufm.common.config;

import com.ufm.auth.jwt.JwtService;
import com.ufm.auth.totp.TotpService;
import com.ufm.common.crypto.SecretCipher;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.time.Clock;

@Configuration
@MapperScan(basePackages = "com.ufm", annotationClass = org.apache.ibatis.annotations.Mapper.class)
@EnableConfigurationProperties({UfmSecurityProperties.class, UfmCryptoProperties.class})
public class UfmCoreConfiguration {

    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }

    @Bean
    public JwtService jwtService(UfmSecurityProperties properties, Clock clock) {
        return new JwtService(
                properties.getJwtSecret(),
                properties.getAccessTtl(),
                properties.getIssuer(),
                clock
        );
    }

    @Bean
    public SecretCipher secretCipher(UfmCryptoProperties properties) {
        return new SecretCipher(properties.getKey());
    }

    @Bean
    public TotpService totpService() {
        return new TotpService();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(10);
    }
}
