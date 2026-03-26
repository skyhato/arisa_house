// cloudfunctions/overwriteImage/index.js
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

/**
 * event 参数：
 *  - cloudPath: 要覆盖的云存储路径，例如 "origin/xxxxx.jpg"
 *  - fileContent: 前端传来的图片 base64 字符串
 */
exports.main = async (event, context) => {
  const { cloudPath, fileContent } = event || {};

  if (!cloudPath || !fileContent) {
    return {
      success: false,
      errorMsg: '缺少 cloudPath 或 fileContent'
    };
  }

  try {
    const buffer = Buffer.from(fileContent, 'base64');

    const res = await cloud.uploadFile({
      cloudPath,
      fileContent: buffer
    });

    return {
      success: true,
      fileID: res.fileID
    };
  } catch (e) {
    return {
      success: false,
      errorMsg: e.message || e.errMsg || '上传异常'
    };
  }
};
