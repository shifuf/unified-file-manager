package com.ufm.worker;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

/**
 * Worker 启动入口（profile: worker）。与 API 共享 server:core 领域模块。
 */
@SpringBootApplication
@ComponentScan(basePackages = "com.ufm")
public class UfmWorkerApplication {

    public static void main(String[] args) {
        SpringApplication.run(UfmWorkerApplication.class, args);
    }
}
