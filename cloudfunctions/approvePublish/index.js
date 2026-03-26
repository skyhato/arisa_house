const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 可把管理员 OPENID 写到 env 或集合 admin_users
const ADMIN_LIST = (process.env.ADMIN_OPENIDS || '').split(',').filter(Boolean)

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { publishId } = event
  if (!publishId) return { ok: false, msg: '缺少 publishId' }

  // 简单鉴权：OPENID 在管理员名单里
  if (!ADMIN_LIST.includes(OPENID)) {
    return { ok: false, msg: '无权限' }
  }

  const res = await db.collection('publish').doc(publishId).update({
    data: {
      status: 'APPROVED',
      auditBy: OPENID,
      auditTime: Date.now(),
      auditReason: '',
      updatedAt: Date.now()
    }
  })
  return { ok: true, updated: res.stats.updated }
}
