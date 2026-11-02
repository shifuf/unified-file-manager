package com.ufm.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

/**
 * API 启动入口（profile: api）。领域实现全部在 server:core。
 */
@SpringBootApplication
@ComponentScan(basePackages = "com.ufm")
public class UfmApiApplication {

    public static void main(String[] args) {
        SpringApplication.run(UfmApiApplication.class, args);
    }
}
