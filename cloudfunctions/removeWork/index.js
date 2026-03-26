const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const COLLECTION_PUBLISH = 'publish';

// 可选：你的管理员 openid，和前端 ADMIN_ID 保持一致
const ADMIN_ID = 'oVwBHviOJOCLpGHUh-kR4q5YomBQ';

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { photoId } = event || {};

  if (!photoId) {
    return { ok: false, code: 'MISSING_ID', msg: '缺少作品ID' };
  }

  // 简单管理员校验（也可以改成从 users 表里查角色）
  if (OPENID !== ADMIN_ID) {
    return { ok: false, code: 'NO_AUTH', msg: '无权限删除作品' };
  }

  try {
    // 1) 先取文档，拿到 fileID
    const docRes = await db.collection(COLLECTION_PUBLISH).doc(String(photoId)).get();
    const doc = docRes?.data;
    if (!doc) {
      return { ok: false, code: 'NOT_FOUND', msg: '作品不存在或已删除' };
    }

    const fileIds = [];
    if (typeof doc.originFileID === 'string' && doc.originFileID.startsWith('cloud://')) {
      fileIds.push(doc.originFileID);
    }
    if (typeof doc.thumbFileID === 'string' && doc.thumbFileID.startsWith('cloud://')) {
      fileIds.push(doc.thumbFileID);
    }

    // 2) 删除云存储文件（忽略单独的删除失败，不影响文档删除）
    if (fileIds.length) {
      try {
        await cloud.deleteFile({ fileList: fileIds });
      } catch (e) {
        console.warn('[removeWork] deleteFile error:', e);
      }
    }

    // 3) 删除数据库文档
    await db.collection(COLLECTION_PUBLISH).doc(String(photoId)).remove();

    return { ok: true, msg: '删除成功' };
  } catch (err) {
    console.error('[removeWork] error:', err);
    return { ok: false, code: 'EXCEPTION', msg: err.message || '删除失败' };
  }
};
