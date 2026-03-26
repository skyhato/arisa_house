// 云函数入口文件：approveWork（优化版）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _  = db.command;

const COLLECTION_PUBLISH = 'publish';
const ADMINS_COLLECTION  = 'admins';

// 你现在 admins 表有 role（super_admin），但你这份 isAdmin 只看 enabled。
// 我这里提供“可选 role 校验”，默认不启用，避免我乱猜你规则。
const CHECK_ROLE = false;
const ALLOW_ROLES = ['admin', 'super_admin'];

async function isAdmin(OPENID) {
  try {
    const q = db.collection(ADMINS_COLLECTION).where({
      openid: String(OPENID),
      enabled: true
    });

    const { data } = await q.limit(1).get();
    if (!(data && data.length)) return false;

    if (!CHECK_ROLE) return true;
    const role = String(data[0].role || '');
    return ALLOW_ROLES.includes(role);
  } catch (e) {
    console.error('[approveWork][isAdmin] query error:', e);
    return false;
  }
}

exports.main = async (event, context) => {
  const { OPENID, ENV } = cloud.getWXContext();
  const { photoId } = event || {};

  if (!photoId) return { ok: false, msg: '缺少 photoId' };

  // 管理员校验
  const admin = await isAdmin(OPENID);
  if (!admin) return { ok: false, msg: '无权限（管理员校验未通过）', openid: OPENID, env: ENV };

  try {
    // 直接尝试更新（避免先 get 一次）
    const upr = await db.collection(COLLECTION_PUBLISH)
      .where({ _id: String(photoId), status: _.neq('APPROVED') })
      .update({
        data: { status: 'APPROVED', updatedAt: Date.now() }
      });

    const updated = (upr?.stats?.updated || upr?.stats?.updatedDocuments || 0);
    if (updated === 1) return { ok: true, updated };

    // updated=0：可能是已经 APPROVED，也可能是记录不存在
    const chk = await db.collection(COLLECTION_PUBLISH).doc(String(photoId)).get().catch(() => null);
    if (!chk?.data) {
      return { ok: false, msg: '未找到该作品（env 或 id 不匹配）', photoId, env: ENV };
    }
    if (chk.data.status === 'APPROVED') {
      return { ok: true, updated: 0, alreadyApproved: true };
    }
    return { ok: false, msg: '未更新到数据', currentStatus: chk.data.status, photoId, env: ENV };
  } catch (e) {
    console.error('[approveWork] exception:', e);
    return { ok: false, msg: e.message || '云函数异常', env: ENV };
  }
};
