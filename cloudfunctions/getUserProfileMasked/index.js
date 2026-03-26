// 云函数：getUserProfileMasked
// 功能：根据 openid 查询 users 集合，返回「打过码的昵称」和头像字段

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 和前端一致的打码规则：
// 1. 长度 =1  => "*"
// 2. 长度 =2  => "*后一字" 例如 "小明" -> "*明"
// 3. 长度 ≥3 => 首尾保留，中间全是 *，例如 "小明同学" -> "小**学"
function maskNickname(name) {
  if (!name) return '';
  const str = String(name);
  const len = str.length;
  if (len === 1) {
    return '*';
  } else if (len === 2) {
    return '*' + str[1];
  } else {
    const middle = '*'.repeat(len - 2);
    return str[0] + middle + str[len - 1];
  }
}

exports.main = async (event, context) => {
  try {
    const wxCtx = cloud.getWXContext();
    const openid = String(event.openid || wxCtx.OPENID || '');

    if (!openid) {
      return { ok: false, msg: '缺少 openid' };
    }

    const res = await db.collection('users')
      .where(_.or([
        { openid },
        { _openid: openid }
      ]))
      .limit(1)
      .get();

    const user = res.data && res.data[0];
    if (!user) {
      return {
        ok: true,
        avatarUrl: '',
        nicknameMasked: ''
      };
    }

    const rawNickname =
      user.nickname ||
      user.username ||
      '';

    const nicknameMasked = maskNickname(rawNickname);
    const avatarUrl =
      user.avatarUrl ||
      user.avatar ||
      '';

    return {
      ok: true,
      avatarUrl,
      nicknameMasked
    };
  } catch (e) {
    console.error('[getUserProfileMasked] error:', e);
    return {
      ok: false,
      msg: e.message || String(e)
    };
  }
};
