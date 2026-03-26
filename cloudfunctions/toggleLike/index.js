// cloudfunctions/toggleLike/index.js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _  = db.command;

const COL_PUBLISH = 'publish';
const COL_USERS   = 'users';
const COL_NOTI    = 'notifications';

// users._id 形态：24位小写hex
const isUsersId = v => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v);

/**
 * 尽力解析作品作者的 openid：
 * 1) 直接从 publish 本身的若干字段拿；
 * 2) 若拿到的是 users._id，则去 users 表把 openid 读出来；
 * 解析失败返回空串。
 */
async function resolveOwnerOpenid(pub) {
  if (!pub || typeof pub !== 'object') return '';

  // ① 只用 publish 自身字段（零跨表）
  const candidates = [
    pub.ownerOpenid, pub.openid, pub._openid, pub.userOpenid,
    pub.userID, pub.userId, pub.ownerId, pub.authorId, pub.uid, pub.user
  ].map(x => (x == null ? '' : String(x)));

  // 如果候选里已经有 openid 形态，就直接返回（不做严格正则，避免误杀）
  for (const c of candidates) {
    // openid 一般以 o 开头且较长；这里放宽：不是 24位hex 就优先认为是 openid
    if (c && !isUsersId(c)) return c;
  }

  // ② 若是 users._id，跨表读取 openid
  for (const c of candidates) {
    if (isUsersId(c)) {
      try {
        const u = await db.collection(COL_USERS).doc(c).get();
        if (u && u.data && u.data.openid) return String(u.data.openid);
      } catch (e) {
        console.warn('[toggleLike] users lookup fail:', e && e.message);
      }
    }
  }

  return '';
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { photoId } = event || {};
  if (!photoId) return { ok:false, code:'INVALID_PARAM', msg:'missing photoId' };

  const notifId = `like_${photoId}_${OPENID}`;

  try {
    // 1) 读取作品
    const snap = await db.collection(COL_PUBLISH).doc(String(photoId)).get();
    const pub  = snap.data;
    if (!pub) return { ok:false, code:'NOT_FOUND', msg:'publish not found' };

    // 2) 解析作者 openid（允许跨表）
    const ownerOpenid = await resolveOwnerOpenid(pub);
    console.log('[toggleLike] photoId=', photoId, 'ownerOpenid=', ownerOpenid, 'liker=', OPENID);

    // 3) 点赞切换（计算当前状态）
    const likedBy = Array.isArray(pub.likedBy) ? pub.likedBy.map(String) : [];
    const already = likedBy.includes(OPENID);

    if (already) {
      // 取消点赞
      await db.collection(COL_PUBLISH).doc(String(photoId)).update({
        data: { likedBy: _.pull(OPENID), likesCount: _.inc(-1) }
      });

      // 有作者openid才删除通知（幂等）
      if (ownerOpenid) {
        try { await db.collection(COL_NOTI).doc(notifId).remove(); } catch (_) {}
      } else {
        console.warn('[toggleLike] owner openid missing, skip remove noti');
      }

      // 返回新计数
      const after = await db.collection(COL_PUBLISH).doc(String(photoId)).get();
      return { ok:true, liked:false, likesCount: Number(after.data.likesCount || 0) };
    } else {
      // 点赞
      await db.collection(COL_PUBLISH).doc(String(photoId)).update({
        data: { likedBy: _.addToSet(OPENID), likesCount: _.inc(1) }
      });

      // 写/更新通知（只有解析到作者openid才写）
      if (ownerOpenid) {
        const noti = {
          type: 'LIKE',
          ownerId: ownerOpenid,          // ✅ 统一写作者的 openid
          likerId: OPENID,
          photoId: String(photoId),
          thumbFileID: pub.thumbFileID || '',
          publishCreatedAt: pub.createdAt || null,
          read: false
        };
        try {
          await db.collection(COL_NOTI).doc(notifId).set({
            data: { ...noti, createdAt: Date.now() } // createdAt 只在首写
          });
        } catch (_) {
          // 存在则更新可变字段（不覆盖 createdAt）
          try { await db.collection(COL_NOTI).doc(notifId).update({ data: { ...noti } }); } catch (__) {}
        }
      } else {
        console.warn('[toggleLike] owner openid missing, skip create noti');
      }

      // 返回新计数
      const after = await db.collection(COL_PUBLISH).doc(String(photoId)).get();
      return { ok:true, liked:true, likesCount: Number(after.data.likesCount || 0) };
    }
  } catch (e) {
    console.error('[toggleLike] error:', e);
    return { ok:false, code:'UPDATE_FAIL', msg: e.message || 'update failed' };
  }
};
