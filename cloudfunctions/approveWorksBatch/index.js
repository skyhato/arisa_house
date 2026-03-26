// 云函数入口文件：approveWorksBatch
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _  = db.command;

const COLLECTION_PUBLISH = 'publish';
const ADMINS_COLLECTION  = 'admins';

// 同上：可选 role 校验
const CHECK_ROLE = false;
const ALLOW_ROLES = ['admin', 'super_admin'];

async function isAdmin(OPENID) {
  const { data } = await db.collection(ADMINS_COLLECTION)
    .where({ openid: String(OPENID), enabled: true })
    .limit(1)
    .get();

  if (!(data && data.length)) return false;
  if (!CHECK_ROLE) return true;

  const role = String(data[0].role || '');
  return ALLOW_ROLES.includes(role);
}

exports.main = async (event, context) => {
  const { OPENID, ENV } = cloud.getWXContext();
  const ids = Array.isArray(event.photoIds) ? event.photoIds.map(x => String(x)).filter(Boolean) : [];

  if (!ids.length) return { ok: true, updated: 0, env: ENV };

  // 只校验一次
  const admin = await isAdmin(OPENID);
  if (!admin) return { ok: false, msg: '无权限（管理员校验未通过）', env: ENV };

  const CHUNK = 200; // 保守点，避免 _id in 太大
  let updatedTotal = 0;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);

    const r = await db.collection(COLLECTION_PUBLISH)
      .where({ _id: _.in(part), status: _.neq('APPROVED') })
      .update({
        data: { status: 'APPROVED', updatedAt: Date.now() }
      });

    updatedTotal += (r?.stats?.updated || r?.stats?.updatedDocuments || 0);
  }

  return { ok: true, updated: updatedTotal, requested: ids.length, env: ENV };
};
