// cloudfunctions/pullNotifications/index.js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { cursor = 0, limit = 15, markRead = true } = event || {};

  console.log('[pullNotifications] OPENID=', OPENID, 'cursor=', cursor, 'limit=', limit);

  try {
    // 1) 拉取我作为被点赞者的通知
    const snap = await db.collection('notifications')
      .where({ ownerId: OPENID, type: 'LIKE' })
      .orderBy('createdAt', 'desc')
      .skip(Number(cursor))
      .limit(Number(limit))
      .get();

    console.log('[pullNotifications] fetched=', snap.data.length);

    // 2) 取点赞者基本信息
    const list = snap.data || [];
    const likerIds = Array.from(new Set(list.map(n => String(n.likerId)).filter(Boolean)));
    let userMap = new Map();
    if (likerIds.length) {
      const users = await db.collection('users')
        .where({ openid: _.in(likerIds) })
        .field({ openid: true, nickname: true, avatar: true })
        .get();
      (users.data || []).forEach(u => {
        userMap.set(String(u.openid), { name: u.nickname || '匿名用户', avatar: u.avatar || '' });
      });
    }

    // 3) 组装返回
    const items = list.map(n => {
      const u = userMap.get(String(n.likerId)) || {};
      return {
        id: n._id,
        photoId: n.photoId,
        thumbFileID: n.thumbFileID || '',
        likerOpenid: n.likerId,
        likerName: u.name || '匿名用户',
        likerAvatar: u.avatar || '',
        read: !!n.read,
        createdAt: n.createdAt || null
      };
    });

    // 4) 可选：置已读
    if (markRead) {
      const unreadIds = list.filter(n => !n.read).map(n => n._id);
      const batchSize = 20;
      for (let i = 0; i < unreadIds.length; i += batchSize) {
        const part = unreadIds.slice(i, i + batchSize);
        await db.collection('notifications').where({ _id: _.in(part) }).update({ data: { read: true } });
      }
    }

    return {
      ok: true,
      items,
      nextCursor: Number(cursor) + items.length,
      hasMore: items.length === Number(limit)
    };
  } catch (e) {
    console.error('[pullNotifications] ERROR:', e);
    return { ok: false, code: 'PULL_FAIL', msg: e.errMsg || e.message || 'unknown error' };
  }
};
