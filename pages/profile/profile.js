// pages/profile/profile.js
const COLLECTION_USERS = 'users';

Page({
  data: {
    user: null,
    openid: '',
    nickname: '',
    avatarFileID: '',
    avatarPreview: '',
    uploadingAvatar: false,
    savingNickname: false,
    isAdmin: false // 管理员标识
  },

  onLoad() {
    this._ensureLoginAndLoad();
  },

  /* ========== 登录与资料加载 ========== */
  async _ensureLoginAndLoad() {
    const user = wx.getStorageSync('user');
    if (!user || !(user.openid || user.openId)) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }

    const openid = user.openid || user.openId;
    const nickname = user.nickname || '';
    let avatarPreview = user.avatarUrlResolved || user.avatarUrl || user.avatar || '';

    // cloud:// -> 临时 https
    if (avatarPreview && avatarPreview.startsWith && avatarPreview.startsWith('cloud://')) {
      try {
        const { fileList } = await wx.cloud.getTempFileURL({ fileList: [avatarPreview] });
        avatarPreview = (fileList && fileList[0] && fileList[0].tempFileURL) || '';
      } catch (_) {}
    }

    // 检查管理员
    let isAdmin = false;
    try {
      const res = await wx.cloud.callFunction({ name: 'checkAdmin' });
      const ret = res.result || {};
      isAdmin = !!ret.isAdmin;
    } catch (err) {
      console.warn('[profile] checkAdmin 调用失败:', err);
    }

    this.setData({ user, openid, nickname, avatarPreview, isAdmin });
    this._pullFromDB(openid);
  },

  async _pullFromDB(openid) {
    const db = wx.cloud.database();
    try {
      let uDoc = null;
      // 先按 doc(openid) 查
      try {
        const r = await db.collection(COLLECTION_USERS).doc(String(openid)).get();
        uDoc = r.data || null;
      } catch (_) {
        // 再按 openid 字段兜底
        const r2 = await db.collection(COLLECTION_USERS)
          .where({ openid: String(openid) })
          .limit(1)
          .get();
        uDoc = (r2.data && r2.data[0]) || null;
      }
      if (!uDoc) return;

      const nickname = uDoc.nickname || this.data.nickname || '';
      // 和 my.js 保持字段优先级一致一些
      let avatarFileID = uDoc.avatar || uDoc.avatarFileID || uDoc.avatarUrl || '';
      let avatarPreview = this.data.avatarPreview;

      if (avatarFileID) {
        if (avatarFileID.startsWith && avatarFileID.startsWith('cloud://')) {
          try {
            const { fileList } = await wx.cloud.getTempFileURL({ fileList: [avatarFileID] });
            avatarPreview = (fileList && fileList[0] && fileList[0].tempFileURL) || avatarPreview;
          } catch (_) {}
        } else {
          avatarPreview = avatarFileID;
        }
      }

      this.setData({ nickname, avatarFileID, avatarPreview });

      // 同步回本地缓存
      const user = wx.getStorageSync('user') || {};
      user.nickname = nickname;
      user.avatar = avatarFileID || user.avatar;
      user.avatarUrlResolved = avatarPreview;
      wx.setStorageSync('user', user);
    } catch (e) {
      console.error('拉取用户资料失败:', e);
    }
  },

  /* ========== 修改头像 ========== */
  onChangeAvatar() {
    const { openid, uploadingAvatar } = this.data;
    if (!openid) return wx.showToast({ title: '未登录', icon: 'none' });
    if (uploadingAvatar) return; // 防止重复点击

    wx.chooseImage({
      count: 1,
      success: async (res) => {
        try {
          this.setData({ uploadingAvatar: true });
          const tempPath = res.tempFilePaths[0];
          let filePath = tempPath;

          // 尝试压缩一轮
          try {
            const cr = await wx.compressImage({ src: tempPath, quality: 80 });
            filePath = cr.tempFilePath;
          } catch (_) {}

          // 上传到云存储
          const up = await wx.cloud.uploadFile({
            cloudPath: `avatars/${openid}-${Date.now()}.jpg`,
            filePath
          });

          const db = wx.cloud.database();
          const col = db.collection(COLLECTION_USERS);
          const fileID = up.fileID;

          // 先查 doc(openid) 有没有
          let docId = String(openid);
          let hasDocById = false;
          try {
            const r = await col.doc(docId).get();
            if (r && r.data) hasDocById = true;
          } catch (_) {}

          if (hasDocById) {
            // 只更新头像，不破坏其他字段
            await col.doc(docId).update({
              data: { avatar: fileID }
            });
          } else {
            // 再按 openid 字段兜底
            const found = await col.where({ openid: String(openid) }).limit(1).get();
            if (found.data && found.data[0]) {
              await col.doc(found.data[0]._id).update({
                data: { avatar: fileID }
              });
              docId = found.data[0]._id;
            } else {
              // 都没有就新建
              await col.add({
                data: { openid, avatar: fileID }
              });
            }
          }

          // 生成预览链接
          let preview = '';
          try {
            const { fileList } = await wx.cloud.getTempFileURL({ fileList: [fileID] });
            preview = fileList && fileList[0] && fileList[0].tempFileURL;
          } catch (_) {}

          this.setData({
            avatarFileID: fileID,
            avatarPreview: preview || filePath
          });

          // 更新本地缓存
          const user = wx.getStorageSync('user') || {};
          user.avatar = fileID;
          user.avatarUrlResolved = preview || filePath;
          wx.setStorageSync('user', user);

          wx.showToast({ title: '头像已更新', icon: 'success' });
        } catch (e) {
          console.error('更新头像失败:', e);
          wx.showToast({ title: '更新失败', icon: 'none' });
        } finally {
          this.setData({ uploadingAvatar: false });
        }
      }
    });
  },

  /* ========== 修改昵称 ========== */
  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  async onSaveNickname() {
    let { openid, nickname, savingNickname } = this.data;
    if (!openid) return wx.showToast({ title: '未登录', icon: 'none' });
    if (savingNickname) return;
    nickname = (nickname || '').trim();
    if (!nickname) return wx.showToast({ title: '请输入昵称', icon: 'none' });

    try {
      this.setData({ savingNickname: true });
      const db = wx.cloud.database();
      const col = db.collection(COLLECTION_USERS);

      // 同样先按 doc(openid) 再按 openid 字段兜底
      let docId = String(openid);
      let hasDocById = false;
      try {
        const r = await col.doc(docId).get();
        if (r && r.data) hasDocById = true;
      } catch (_) {}

      if (hasDocById) {
        await col.doc(docId).update({
          data: { nickname }
        });
      } else {
        const found = await col.where({ openid: String(openid) }).limit(1).get();
        if (found.data && found.data[0]) {
          await col.doc(found.data[0]._id).update({
            data: { nickname }
          });
          docId = found.data[0]._id;
        } else {
          await col.add({
            data: { openid, nickname }
          });
        }
      }

      const user = wx.getStorageSync('user') || {};
      user.nickname = nickname;
      wx.setStorageSync('user', user);
      this.setData({ nickname });

      wx.showToast({ title: '昵称已保存', icon: 'success' });
    } catch (e) {
      console.error('保存昵称失败:', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      this.setData({ savingNickname: false });
    }
  },

  /* ========== 管理员功能入口 ========== */
  goToAudit() {
    if (!this.data.isAdmin) {
      return wx.showToast({ title: '仅管理员可访问', icon: 'none' });
    }
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  goToUserAdmin() {
    if (!this.data.isAdmin) {
      return wx.showToast({ title: '仅管理员可访问', icon: 'none' });
    }
    wx.navigateTo({ url: '/pages/userAdmin/userAdmin' });
  },

  /* ========== 登出与返回 ========== */
  onLogout() {
    wx.showModal({
      title: '确认退出',
      content: '退出后需要重新登录才能发布与点赞',
      success: (res) => {
        if (!res.confirm) return;
        try { wx.removeStorageSync('user'); } catch (_) {}
        wx.showToast({ title: '已退出', icon: 'none' });
        wx.reLaunch({ url: '/pages/login/login' });
      }
    });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  }
});
