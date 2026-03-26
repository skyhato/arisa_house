package com.wxapp.backend.wxapp_server.service;

import com.wxapp.backend.wxapp_server.domain.User;
import com.wxapp.backend.wxapp_server.mapper.UserMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

@Service
public class UserService {

    @Autowired
    private UserMapper userMapper;

    @Value("${wx.appid}")
    private String appid;

    @Value("${wx.secret}")
    private String secret;

    @Value("${wx.loginUrl}")
    private String wxLoginUrl;

    private final RestTemplate restTemplate = new RestTemplate();

    /**
     * 微信登录
     *
     * @param code 微信前端传来的临时 code
     * @param nickname 微信昵称
     * @return 数据库用户信息
     */
    public User wxLogin(String code, String nickname) {
        // 拼接请求 URL
        String url = wxLoginUrl + "?appid=" + appid
                + "&secret=" + secret
                + "&js_code=" + code
                + "&grant_type=authorization_code";

        System.out.println("请求微信 URL: " + url);

        // 调用微信 API
        Map<String, String> res = restTemplate.getForObject(url, Map.class);
        if (res == null || res.get("openid") == null) {
            throw new RuntimeException("获取 openid 失败: " + res);
        }

        String openid = res.get("openid");

        // 查询或创建用户
        User user = userMapper.findByOpenid(openid);
        if (user == null) {
            user = new User();
            user.setOpenid(openid);
            user.setUsername(nickname != null && !nickname.isEmpty() ? nickname : "微信用户");
            userMapper.insert(user);
        }

        return user;
    }
}
