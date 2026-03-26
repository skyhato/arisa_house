package com.wxapp.backend.wxapp_server.mapper;

import com.wxapp.backend.wxapp_server.domain.User;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserMapper {

    // 根据 openid 查询用户
    @Select("SELECT * FROM user WHERE openid = #{openid}")
    User findByOpenid(String openid);

    // 插入新用户
    @Insert("INSERT INTO user(username, openid) VALUES(#{username}, #{openid})")
    void insert(User user);
}
