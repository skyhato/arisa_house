// 云函数：grantPublishUnlimited
// 作用：用户看完广告后，记录“今天可无限发布”

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _  = db.command;

const COLLECTION_USERS = 'users';

function getTodayStr(ts) {
  const d = ts ? new Date(ts) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, code: 'UNAUTH', msg: '未登录' };
  }

  const todayStr = getTodayStr(Date.now());

  try {
    const res = await db.collection(COLLECTION_USERS)
      .where(_.or([{ openid: OPENID }, { _openid: OPENID }]))
      .update({
        data: {
          publishUnlimitedDate: todayStr
        }
      });

    if (!res.stats || res.stats.updated === 0) {
      return { ok: false, code: 'NO_USER', msg: '未找到用户' };
    }

    return { ok: true, date: todayStr };
  } catch (e) {
    return { ok: false, code: 'DB_FAIL', msg: e.message || '数据库更新失败' };
  }
};
