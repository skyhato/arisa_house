package com.wxapp.backend.wxapp_server.controller;


import com.wxapp.backend.wxapp_server.domain.User;
import com.wxapp.backend.wxapp_server.service.UserService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;
import org.json.JSONObject;

@RestController
@RequestMapping("/api")
public class LoginController {

    @Autowired
    private UserService userService;

    // 小程序传 code 登录
    @PostMapping("/wxlogin")
    public User wxLogin(@RequestParam String code, @RequestParam(required = false) String nickname) {
        // 1. 用 code 换取 openid
        String appid = "你的AppID";        // 替换成你的小程序 AppID
        String secret = "你的AppSecret";   // 替换成你的小程序 AppSecret
        String url = String.format(
                "https://api.weixin.qq.com/sns/jscode2session?appid=%s&secret=%s&js_code=%s&grant_type=authorization_code",
                appid, secret, code
        );

        RestTemplate restTemplate = new RestTemplate();
        String result = restTemplate.getForObject(url, String.class);

        JSONObject json = new JSONObject(result);
        if (!json.has("openid")) {
            throw new RuntimeException("微信登录失败: " + result);
        }

        String openid = json.getString("openid");

        // 2. 调用 Service 登录/注册
        return userService.wxLogin(openid, nickname);
    }
}
