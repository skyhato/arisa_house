const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV }); // ★ 动态环境
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID, APPID, UNIONID } = cloud.getWXContext();
  const { nickname, avatarFileID, avatarUrl } = event || {};
  const users = db.collection('users');
  const now = Date.now();

  try {
    // 1) 参数兜底：头像优先 fileID，其次 url；允许先注册再补头像
    const avatar = typeof avatarFileID === 'string' && avatarFileID
      ? avatarFileID
      : (typeof avatarUrl === 'string' ? avatarUrl : '');

    // 2) 查现有用户：兼容 _openid 与 openid
    const found = await users.where(
      db.command.or([
        { _openid: OPENID },
        { openid: OPENID }
      ])
    ).limit(1).get();

    if (!found.data.length) {
      // 3) 新增：一定要写 _openid
      const addRes = await users.add({
        data: {
          _openid: OPENID,           // ★ 必须手动写入
          openid: OPENID,            // 兼容你项目里 openid 的查法
          appid: APPID || '',
          unionid: UNIONID || '',
          nickname: nickname || '微信用户',
          avatar: avatar || '',      // 建议传 cloud://fileID；临时先存空字符串也可
          role: 'user',
          createdAt: now,
          updatedAt: now
        }
      });
      return { success: true, action: 'add', id: addRes._id, openid: OPENID };
    } else {
      // 4) 更新：仅更新有值的字段
      const docId = found.data[0]._id;
      const patch = { updatedAt: now };
      if (nickname) patch.nickname = nickname;
      if (avatar) patch.avatar = avatar;

      await users.doc(docId).update({ data: patch });
      return { success: true, action: 'update', id: docId, openid: OPENID };
    }
  } catch (e) {
    console.error('[registerUser] error =>', e); // ★ 详细日志
    return { success: false, message: e?.message || String(e) };
  }
};
