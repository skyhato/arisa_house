// 云函数：createPublish
// 作用：创建一条发布记录到 publish 集合（✅已补上 activityId / activityName 写入）
// 新增：每次新上传自动分配自增 photoId

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _  = db.command;

const COLLECTION_PUBLISH  = 'publish';
const COLLECTION_USERS    = 'users';
const COLLECTION_ROLES    = 'roles';

// ✅ 新增：图片ID计数器集合
const COLLECTION_COUNTERS = 'counters';
const PHOTO_ID_COUNTER_ID = 'publish_photo_id';

// ==== 可调参数 ====
const REQUIRE_CLOUD_FILEID = true;        // 若要求图片必须是 cloud:// 文件ID，设为 true；如接受 https 则设为 false
const MAX_MESSAGE_LEN      = 500;         // 留言最大长度
const MAX_LOCATION_LEN     = 80;          // 地点最大长度
const MIN_INTERVAL_MS      = 8000;        // 同一用户发布限流：8秒
const DUP_WINDOW_MS        = 5 * 60 * 1000;  // 5分钟内，originFileID 重复则拒绝

// ==== 每日发布上限（自然日 0 点刷新）====
const DAILY_PUBLISH_LIMIT  = 3;

// 简单日期字符串：YYYY-MM-DD（用系统时区）
function getTodayStr(ts) {
  const d = ts ? new Date(ts) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 兼容：字段可能是字符串，也可能是 Date
function normDateFieldToStr(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  try {
    return getTodayStr(v);
  } catch (e) {
    return '';
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  // —— 0) 基本登录校验 ——
  if (!OPENID) {
    return { ok: false, code: 'UNAUTH', msg: '未登录或 OPENID 获取失败' };
  }

  // 入参解构（✅包含前端新增字段：activityId/activityName）
  const {
    originFileID,
    thumbFileID,
    roleIds = [],
    roleNames = [],
    message = '',
    locationName = '',
    longitude = null,
    latitude  = null,

    // ✅ 活动（可选）
    activityId = '',
    activityName = '',

    // 展示字段
    originUrl = '',
    thumbUrl  = '',
    roundThumbFileID = '',   // 圆角缩略图 fileID
    roundThumbUrl     = '',  // 圆角缩略图 https

    nickname: nicknameFromClient = '',
    avatarUrl: avatarUrlFromClient = '',
    userId: userIdFromClient = ''
  } = event || {};

  // —— 1) 必填项校验 ——
  if (!originFileID) return { ok: false, code: 'MISSING', msg: '缺少 originFileID' };
  if (!thumbFileID)  return { ok: false, code: 'MISSING', msg: '缺少 thumbFileID' };
  if (!Array.isArray(roleIds) || roleIds.length === 0) {
    return { ok: false, code: 'INVALID', msg: 'roleIds 至少包含一个角色' };
  }

  // —— 2) 文件ID / URL 合法性 ——
  const isCloud = id => typeof id === 'string' && id.startsWith('cloud://');
  const isHttp  = id => typeof id === 'string' && /^https?:\/\//i.test(id);

  if (REQUIRE_CLOUD_FILEID) {
    if (!isCloud(originFileID) || !isCloud(thumbFileID)) {
      return { ok: false, code: 'FILEID', msg: '图片必须为云文件 fileID（cloud://）' };
    }
    if (roundThumbFileID && !isCloud(roundThumbFileID)) {
      return { ok: false, code: 'FILEID', msg: 'roundThumbFileID 必须为云文件 fileID（cloud://）' };
    }
  } else {
    if (!(isCloud(originFileID) || isHttp(originFileID))) {
      return { ok: false, code: 'FILEID', msg: 'originFileID 非法' };
    }
    if (!(isCloud(thumbFileID) || isHttp(thumbFileID))) {
      return { ok: false, code: 'FILEID', msg: 'thumbFileID 非法' };
    }
    if (roundThumbFileID && !(isCloud(roundThumbFileID) || isHttp(roundThumbFileID))) {
      return { ok: false, code: 'FILEID', msg: 'roundThumbFileID 非法' };
    }
  }

  // —— 3) 文本与经纬度校验 ——
  const msgStr = String(message || '');
  const locStr = String(locationName || '');

  if (msgStr.length > MAX_MESSAGE_LEN) {
    return { ok: false, code: 'TEXT_LEN', msg: `留言过长（>${MAX_MESSAGE_LEN} 字）` };
  }
  if (locStr.length > MAX_LOCATION_LEN) {
    return { ok: false, code: 'TEXT_LEN', msg: `地点过长（>${MAX_LOCATION_LEN} 字）` };
  }

  if (longitude != null) {
    const lon = Number(longitude);
    if (Number.isNaN(lon) || lon < -180 || lon > 180) {
      return { ok: false, code: 'GEO', msg: '经度范围应在[-180,180]' };
    }
  }
  if (latitude != null) {
    const lat = Number(latitude);
    if (Number.isNaN(lat) || lat < -90 || lat > 90) {
      return { ok: false, code: 'GEO', msg: '纬度范围应在[-90,90]' };
    }
  }

  // —— 4) 用户注册校验（users 里必须存在） ——
  let userProfile = null;
  try {
    const ures = await db.collection(COLLECTION_USERS)
      .where(_.or([{ openid: OPENID }, { _openid: OPENID }]))
      .limit(1)
      .get();
    userProfile = (ures.data && ures.data[0]) || null;
  } catch (e) {
    // ignore
  }
  if (!userProfile) {
    return { ok: false, code: 'NO_USER', msg: '未找到用户，请先完成注册' };
  }

  // —— 4.5) 每日次数限制（看广告后今日无限） ——
  const now = Date.now();
  const todayStr = getTodayStr(now);

  const publishUnlimitedStr = normDateFieldToStr(userProfile.publishUnlimitedDate);
  const adUnlimitedStr      = normDateFieldToStr(userProfile.adUnlimitedDate);

  const unlimitedToday =
    publishUnlimitedStr === todayStr ||
    adUnlimitedStr === todayStr;

  if (!unlimitedToday) {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayCountRes = await db.collection(COLLECTION_PUBLISH)
        .where({
          openid: OPENID,
          createdAt: _.gte(todayStart)
        })
        .count();

      if ((todayCountRes.total || 0) >= DAILY_PUBLISH_LIMIT) {
        return {
          ok: false,
          code: 'DAILY_LIMIT',
          msg: `已达到每天上传限制（最多 ${DAILY_PUBLISH_LIMIT} 张）`
        };
      }
    } catch (e) {
      console.warn('[createPublish] daily limit check fail:', e);
    }
  }

  // —— 5) 限流：同一用户最近 MIN_INTERVAL_MS 内仅允许一次发布 ——
  try {
    const recent = await db.collection(COLLECTION_PUBLISH)
      .where({
        openid: OPENID,
        createdAt: _.gte(new Date(now - MIN_INTERVAL_MS))
      })
      .count();
    if (recent.total > 0) {
      return { ok: false, code: 'RATE_LIMIT', msg: '操作太频繁，请稍后再试' };
    }
  } catch (e) {
    // ignore
  }

  // —— 6) 去重：5 分钟内相同 originFileID 的重复提交拒绝 ——
  try {
    const dup = await db.collection(COLLECTION_PUBLISH)
      .where({
        openid: OPENID,
        originFileID: originFileID,
        createdAt: _.gte(new Date(now - DUP_WINDOW_MS))
      })
      .count();
    if (dup.total > 0) {
      return { ok: false, code: 'DUP', msg: '该图片已提交，请勿重复发布' };
    }
  } catch (e) {
    // ignore
  }

  // —— 7) 角色存在性校验 + 规范化 roleIds / roleNames ——
  const normRoleIds = Array.from(
    new Set(
      roleIds.map(x => String(x)).filter(Boolean)
    )
  );

  let finalRoleNames = Array.isArray(roleNames)
    ? roleNames.map(x => String(x)).filter(Boolean)
    : [];

  try {
    const rres = await db.collection(COLLECTION_ROLES)
      .where({ _id: _.in(normRoleIds) })
      .get();

    const validRoles = rres.data || [];
    if (validRoles.length === 0) {
      return { ok: false, code: 'ROLE_NOT_FOUND', msg: '角色无效，请重新选择' };
    }

    const validIds = validRoles.map(r => String(r._id));
    finalRoleNames = validRoles.map(r => r.name || r.roleName || '未命名角色');

    normRoleIds.splice(0, normRoleIds.length, ...validIds);
  } catch (e) {
    return { ok: false, code: 'ROLE_QUERY_FAIL', msg: '角色校验失败，请重试' };
  }

  // —— 8) 组装用户展示信息（支持前端覆盖） ——
  let nickname =
    String(nicknameFromClient || '').trim() ||
    String(userProfile.nickname || userProfile.nickName || '') ||
    '匿名用户';

  let avatarFileID = userProfile.avatar || userProfile.avatarFileID || '';
  if (avatarFileID && !avatarFileID.startsWith('cloud://')) {
    avatarFileID = '';
  }

  let avatarUrl = String(avatarUrlFromClient || userProfile.avatarUrl || '').trim();
  if (avatarUrl && !isHttp(avatarUrl)) {
    avatarUrl = '';
  }

  // —— 9) 处理前端传来的 originUrl / thumbUrl / roundThumbUrl（可为空） ——
  let finalOriginUrl     = '';
  let finalThumbUrl      = '';
  let finalRoundThumbUrl = '';

  if (isHttp(originUrl))     finalOriginUrl     = originUrl;
  if (isHttp(thumbUrl))      finalThumbUrl      = thumbUrl;
  if (isHttp(roundThumbUrl)) finalRoundThumbUrl = roundThumbUrl;

  // —— 10) userId 字段：尽量用 users 集合里的主键 ——
  const finalUserId =
    userProfile._id ||
    userIdFromClient ||
    OPENID;

  // —— 10.5) 活动字段规范化 ——
  const actId = String(activityId || '').trim();
  let actName = String(activityName || '').trim();
  if (!actId) actName = '';

  // —— 11) 组装记录（这里只是准备，不直接写库） ——
  const nowDate = new Date(now);

  const record = {
    // ✅ 新增：photoId 会在事务里写入

    // 文件主键：云 fileID
    originFileID,
    thumbFileID,
    roundThumbFileID: roundThumbFileID || '',

    // 展示优化字段
    originUrl:     finalOriginUrl,
    thumbUrl:      finalThumbUrl,
    roundThumbUrl: finalRoundThumbUrl,

    // 角色
    roleIds: normRoleIds,
    roleNames: finalRoleNames,

    // 活动（可选）
    activityId: actId,
    activityName: actName,

    // 文本 & 地理信息
    message: msgStr,
    locationName: locStr,
    longitude: longitude == null ? null : Number(longitude),
    latitude:  latitude  == null ? null : Number(latitude),

    // 上传者
    _openid: OPENID,
    openid: OPENID,
    userId: finalUserId,

    nickname,
    avatarFileID,
    avatarUrl,

    // 状态 & 点赞
    status: 'PENDING',
    likedBy: [],
    likesCount: 0,

    // 时间
    createdAt: nowDate,
    updatedAt: nowDate,

    // 方便做“按日统计”
    dayStr: todayStr
  };

  // —— 12) ✅ 新增：事务中分配 photoId 并写入 publish ——
  let tx = null;
  try {
    tx = await db.startTransaction();

    let counterDoc;
    try {
      const counterRes = await tx.collection(COLLECTION_COUNTERS).doc(PHOTO_ID_COUNTER_ID).get();
      counterDoc = counterRes.data || null;
    } catch (e) {
      throw new Error('请先初始化 counters 集合中的 publish_photo_id 计数器');
    }

    const currentPhotoId = Number(counterDoc && counterDoc.value) || 0;
    const nextPhotoId = currentPhotoId + 1;

    await tx.collection(COLLECTION_COUNTERS).doc(PHOTO_ID_COUNTER_ID).update({
      data: {
        value: nextPhotoId,
        updatedAt: now
      }
    });

    const addRes = await tx.collection(COLLECTION_PUBLISH).add({
      data: {
        ...record,
        photoId: nextPhotoId
      }
    });

    await tx.commit();

    return {
      ok: true,
      id: addRes._id,
      photoId: nextPhotoId,
      msg: '发布成功，等待审核'
    };
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    return { ok: false, code: 'DB_FAIL', msg: err.message || '数据库写入失败' };
  }
};