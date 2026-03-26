const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const COLLECTION = 'publish';

exports.main = async (event, context) => {
  const { docId, roundThumbTempPath } = event || {};

  if (!docId) {
    return { ok: false, msg: '缺少 docId' };
  }
  if (!roundThumbTempPath) {
    return { ok: false, msg: '缺少 roundThumbTempPath' };
  }

  try {
    // 1. 上传到云存储
    const cloudPath = `roundThumb/fix-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const uploadRes = await cloud.uploadFile({
      cloudPath,
      filePath: roundThumbTempPath
    });
    const roundFileID = uploadRes.fileID;

    // 2. 获取临时 https
    let roundUrl = '';
    try {
      const tmp = await cloud.getTempFileURL({ fileList: [roundFileID] });
      roundUrl = tmp.fileList?.[0]?.tempFileURL || '';
    } catch (e) {}

    // 3. 更新数据库
    const updateRes = await db.collection(COLLECTION).doc(docId).update({
      data: {
        roundThumbFileID: roundFileID,
        roundThumbUrl: roundUrl
      }
    });

    const updated = updateRes.stats?.updated || updateRes.updated || 0;
    if (updated > 0) {
      return { ok: true, msg: '写库成功', roundThumbFileID: roundFileID, roundThumbUrl: roundUrl };
    } else {
      return { ok: false, msg: '写库无变化', roundThumbFileID: roundFileID };
    }
  } catch (err) {
    console.error('fixRoundThumbUpload error:', err);
    return { ok: false, msg: err.message || '上传或写库失败' };
  }
};
