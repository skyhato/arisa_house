const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV   // ★ 一定要加上这一句
});

const db = cloud.database();
const ADMINS_COLLECTION = 'admins';

exports.main = async (event, context) => {
  const { OPENID, ENV } = cloud.getWXContext();

  // 临时打几个日志方便你对比环境和 openid
  console.log('[checkAdmin] ENV   =', ENV);
  console.log('[checkAdmin] OPENID=', OPENID);

  try {
    const res = await db.collection(ADMINS_COLLECTION)
      .where({
        openid: OPENID,
        enabled: true
      })
      .limit(1)
      .get();

    console.log('[checkAdmin] query result =', res.data);

    const isAdmin = res.data && res.data.length > 0;

    return {
      ok: true,
      isAdmin
    };
  } catch (e) {
    console.error('[checkAdmin] error:', e);
    return {
      ok: false,
      isAdmin: false,
      msg: '检查管理员失败'
    };
  }
};
