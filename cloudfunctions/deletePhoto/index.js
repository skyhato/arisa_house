// 云函数入口文件：deletePhoto
const cloud = require('wx-server-sdk');

// ✅ 一定要指定 env，避免多次自动探测 & 提示
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const COLLECTION_PUBLISH = 'publish';
const ADMINS_COLLECTION = 'admins';

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { photoId } = event || {};

  if (!photoId) {
    return { ok: false, msg: '缺少参数 photoId', isAdmin: false };
  }

  try {
    // ① 先查记录
    const docRes = await db.collection(COLLECTION_PUBLISH)
      .doc(String(photoId))
      .get()
      .catch(err => {
        // 文档不存在的情况也直接处理
        if (err && /document does not exist/i.test(err.errMsg || err.message || '')) {
          return { data: null };
        }
        throw err;
      });

    const photo = docRes.data;
    if (!photo) {
      return { ok: false, msg: '记录不存在或已删除', isAdmin: false };
    }

    // ② 权限校验：作者本人 或 管理员
    const uploaderOpenid = String(photo.openid || photo.userId || photo._openid || '');
    let isAdmin = false;

    if (String(OPENID) !== uploaderOpenid) {
      // 不是本人时，检查管理员
      const adminRes = await db.collection(ADMINS_COLLECTION)
        .where({ openid: OPENID, enabled: true })
        .limit(1)
        .get();
      isAdmin = adminRes.data && adminRes.data.length > 0;
      if (!isAdmin) {
        return { ok: false, msg: '无权限删除', isAdmin: false };
      }
    }

    // ③ 收集所有可能的文件 ID（多种命名都兜一下）
    const fileIds = [];
    const addId = v => {
      if (typeof v === 'string' && v.startsWith('cloud://') && !fileIds.includes(v)) {
        fileIds.push(v);
      }
    };

    addId(photo.originFileID);
    addId(photo.originFileId);
    addId(photo.thumbFileID);
    addId(photo.thumbFileId);
    addId(photo.roundThumbFileID);
    addId(photo.roundThumbFileId);

    // 如果你以后加了别的 fileId 字段，可以在这里继续 addId()

    // ④ 先删文件（就算失败也继续删文档）
    if (fileIds.length > 0) {
      try {
        await cloud.deleteFile({ fileList: fileIds });
      } catch (fileErr) {
        console.error('[deletePhoto] deleteFile error:', fileErr);
        // 不 return，继续往下删数据库记录
      }
    }

    // ⑤ 删数据库记录
    await db.collection(COLLECTION_PUBLISH)
      .doc(String(photoId))
      .remove();

    return {
      ok: true,
      msg: '删除成功',
      isAdmin,
      deletedFiles: fileIds
    };
  } catch (e) {
    console.error('[deletePhoto] error:', e);
    return {
      ok: false,
      isAdmin: false,
      msg: '删除失败：' + (e && e.message ? e.message : '未知错误')
    };
  }
};
