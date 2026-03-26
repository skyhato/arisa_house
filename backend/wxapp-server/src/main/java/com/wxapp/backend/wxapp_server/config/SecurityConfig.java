package com.wxapp.backend.wxapp_server.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf().disable()          // 禁用 CSRF（方便小程序调试）
            .authorizeRequests()
            .anyRequest().permitAll(); // 所有请求放行

        return http.build();
    }
}
