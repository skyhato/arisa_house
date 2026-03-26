// cloudfunctions/updatePhotoMeta/index.js
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION_PUBLISH = 'publish';
const ADMINS_COLLECTION = 'admins';

async function isAdmin(openid) {
  const { data } = await db.collection(ADMINS_COLLECTION)
    .where({ openid: String(openid) })
    .limit(1)
    .get();
  return !!(data && data.length);
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const {
    photoId,
    locationName = '',
    message = '',
    // ✅ 兼容：旧字段 roles，新字段 roleIds
    roles = [],
    roleIds = [],
    roleNames = [],
    latitude = null,
    longitude = null
  } = event || {};

  if (!photoId) return { ok: false, msg: '缺少 photoId' };

  // 先查出作品，判断是不是本人或管理员
  const docRes = await db.collection(COLLECTION_PUBLISH).doc(String(photoId)).get().catch(() => null);
  if (!docRes || !docRes.data) return { ok: false, msg: '作品不存在' };

  const doc = docRes.data;
  const uploaderOpenid = String(doc.openid || doc.userId || doc._openid || '');

  const adminFlag = await isAdmin(OPENID);
  const isOwner = (String(OPENID) === uploaderOpenid);

  if (!isOwner && !adminFlag) return { ok: false, msg: '无权限编辑' };

  // ======== 判断这次请求是不是“纯精选操作” ========
  const hasFeaturedKey = event && (
    Object.prototype.hasOwnProperty.call(event, 'isFeatured') ||
    Object.prototype.hasOwnProperty.call(event, 'featured')
  );

  // ✅ 这里也要把 roleIds 算作 meta key，否则以后会误判
  const hasMetaKey =
    event &&
    (
      Object.prototype.hasOwnProperty.call(event, 'locationName') ||
      Object.prototype.hasOwnProperty.call(event, 'message') ||
      Object.prototype.hasOwnProperty.call(event, 'roles') ||
      Object.prototype.hasOwnProperty.call(event, 'roleIds') ||   // ✅ 新增
      Object.prototype.hasOwnProperty.call(event, 'roleNames') ||
      Object.prototype.hasOwnProperty.call(event, 'latitude') ||
      Object.prototype.hasOwnProperty.call(event, 'longitude')
    );

  const isPureFeaturedUpdate = hasFeaturedKey && !hasMetaKey;

  // ===============【保留：管理员专用精选逻辑】===============
  if (isPureFeaturedUpdate) {
    if (!adminFlag) return { ok: false, msg: '只有管理员可以标记精选照片' };

    const rawFlag = Object.prototype.hasOwnProperty.call(event, 'isFeatured')
      ? event.isFeatured
      : event.featured;
    const flag = !!rawFlag;

    const patchFeatured = {
      isFeatured: flag,
      updatedAt: db.serverDate()
    };

    await db.collection(COLLECTION_PUBLISH)
      .doc(String(photoId))
      .update({ data: patchFeatured });

    return { ok: true };
  }

  // =============== 下面是“编辑信息”逻辑 ===============

  const patch = {
    status: 'PENDING',
    updatedAt: db.serverDate()
  };

  if (Object.prototype.hasOwnProperty.call(event, 'locationName')) {
    patch.locationName = locationName;
  }
  if (Object.prototype.hasOwnProperty.call(event, 'message')) {
    patch.message = message;
  }

  // ✅ 关键：优先写 roleIds；兼容 roles
  if (Object.prototype.hasOwnProperty.call(event, 'roleIds')) {
    patch.roleIds = (roleIds || []).map(String);
  } else if (Object.prototype.hasOwnProperty.call(event, 'roles')) {
    patch.roleIds = (roles || []).map(String);
  }

  if (Object.prototype.hasOwnProperty.call(event, 'roleNames')) {
    patch.roleNames = Array.isArray(roleNames) ? roleNames : [];
  }
  if (Object.prototype.hasOwnProperty.call(event, 'latitude')) {
    patch.latitude = latitude;
  }
  if (Object.prototype.hasOwnProperty.call(event, 'longitude')) {
    patch.longitude = longitude;
  }

  await db.collection(COLLECTION_PUBLISH)
    .doc(String(photoId))
    .update({ data: patch });

  return { ok: true };
};
