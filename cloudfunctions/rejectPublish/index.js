const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const ADMIN_LIST = (process.env.ADMIN_OPENIDS || '').split(',').filter(Boolean)

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { publishId, reason } = event
  if (!publishId) return { ok: false, msg: '缺少 publishId' }

  if (!ADMIN_LIST.includes(OPENID)) return { ok: false, msg: '无权限' }

  const res = await db.collection('publish').doc(publishId).update({
    data: {
      status: 'REJECTED',
      auditBy: OPENID,
      auditTime: Date.now(),
      auditReason: reason || '',
      updatedAt: Date.now()
    }
  })
  return { ok: true, updated: res.stats.updated }
}
