package com.wxapp.backend.wxapp_server.domain;

import lombok.Data;

@Data
public class User {

    private Long id;         // 主键
    private String username; // 微信昵称或自定义名称
    private String openid;   // 微信唯一标识
    private String sessionKey; // 可选，存 session_key
}
