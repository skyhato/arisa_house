// cloudfunctions/updateUserProfile/index.js
const cloud = require('wx-server-sdk');
cloud.init();

const db = cloud.database();
const Users = db.collection('users');

exports.main = async (event, context) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const profile = event.profile || {}; // 期望 { nickName, avatarUrl, gender }

    if (!openid) {
      return { success: false, message: '无法获取 openid' };
    }

    // 查找已有用户
    const found = await Users.where({ _openid: openid }).limit(1).get();
    if (found.data && found.data.length > 0) {
      const id = found.data[0]._id;
      await Users.doc(id).update({
        data: {
          nickname: profile.nickName || found.data[0].nickname || '',
          avatar: profile.avatarUrl || found.data[0].avatar || '',
          gender: profile.gender || found.data[0].gender || 0,
          updatedAt: db.serverDate()
        }
      });
      return { success: true };
    } else {
      // 若无记录，则创建（可选逻辑）
      const addRes = await Users.add({
        data: {
          nickname: profile.nickName || '',
          avatar: profile.avatarUrl || '',
          gender: profile.gender || 0,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return { success: true, createdId: addRes._id };
    }
  } catch (err) {
    console.error('updateUserProfile 错误：', err);
    return { success: false, message: err.message || 'server error' };
  }
};
