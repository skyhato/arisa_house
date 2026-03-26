const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { found: false, message: 'NO_OPENID' }

  try {
    const col = db.collection('users')
    const q = await col.where({ openid: OPENID }).limit(1).get()

    if (q.data.length > 0) {
      const u = q.data[0]
      // 可选：更新最近登录时间
      try { await col.doc(u._id).update({ data: { lastLoginAt: new Date() } }) } catch (_) {}
      return {
        found: true,
        openid: OPENID,
        userId: u._id,
        nickname: u.nickname || '',
        avatarFileID: u.avatarFileID || ''
      }
    }
    // 未注册
    return { found: false, openid: OPENID }
  } catch (err) {
    return { found: false, message: 'DB_ERROR: ' + (err && err.message) }
  }
}
