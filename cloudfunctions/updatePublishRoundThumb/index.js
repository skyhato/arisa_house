// 云函数：updatePublishRoundThumb
// 作用：给已有的 publish 记录写入 / 覆盖 roundThumbFileID / roundThumbUrl
// 用法：
//   - 你在前端已经生成好圆角图并上传到云存储，拿到 fileID
//   - 可选再调用 getTempFileURL 拿到 https 链接
//   - 然后调用本云函数：
//       wx.cloud.callFunction({
//         name: 'updatePublishRoundThumb',
//         data: {
//           publishId: '某条记录的 _id',
//           roundThumbFileID: 'cloud://...',
//           roundThumbUrl: 'https://...'   // 可空
//         }
//       })

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION_PUBLISH = 'publish';

exports.main = async (event, context) => {
  const { publishId, roundThumbFileID, roundThumbUrl = '' } = event || {};

  if (!publishId || !roundThumbFileID) {
    return { ok: false, code: 'MISSING', msg: '缺少 publishId 或 roundThumbFileID' };
  }

  const docId  = String(publishId).trim();
  const fileId = String(roundThumbFileID).trim();
  const url    = String(roundThumbUrl || '').trim();

  try {
    // 先确认一下文档存在，方便给出 NOT_FOUND 提示
    const getRes = await db.collection(COLLECTION_PUBLISH)
      .doc(docId)
      .get()
      .catch(() => null);

    if (!getRes || !getRes.data) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        msg: '未找到对应的 publish 记录（请确认传的是文档 _id）'
      };
    }

    // 直接覆盖写入 roundThumb（不再判断是否已有）
    const res = await db.collection(COLLECTION_PUBLISH)
      .doc(docId)
      .update({
        data: {
          roundThumbFileID: fileId,
          roundThumbUrl: url,     // 可以是空字符串
          updatedAt: new Date()
        }
      });

    const updated = res.stats && typeof res.stats.updated === 'number'
      ? res.stats.updated
      : 0;

    if (updated === 0) {
      return {
        ok: false,
        code: 'UPDATE_ZERO',
        msg: '未能更新 roundThumb（updated=0）',
        stats: res.stats || {}
      };
    }

    return {
      ok: true,
      msg: 'roundThumb 写入成功（已覆盖原值）',
      stats: res.stats
    };
  } catch (e) {
    return {
      ok: false,
      code: 'DB_FAIL',
      msg: e.message || '数据库更新失败'
    };
  }
};
