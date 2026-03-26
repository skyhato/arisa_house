// pages/register/register.js
Page({
  data: {
    avatarPreview: '',   // 本地预览
    avatarTempPath: '',  // chooseAvatar 返回的临时路径（wxfile:// 或 temp）
    nickname: '',        // 昵称
    loading: false
  },

  // 选择头像（button open-type="chooseAvatar" 才会触发）
  onChooseAvatar(e) {
    const tempPath = (e.detail && e.detail.avatarUrl) ? e.detail.avatarUrl : '';
    this.setData({
      avatarPreview: tempPath,
      avatarTempPath: tempPath
    });
  },

  // 输入昵称
  onNickInput(e) {
    this.setData({ nickname: (e.detail.value || '').trim() });
  },

  // 完成注册
  async onSubmit() {
    if (this.data.loading) return;

    const nickname = this.data.nickname;
    const avatarTempPath = this.data.avatarTempPath;

    if (!nickname) {
      wx.showToast({ title: '请先填写昵称', icon: 'none' });
      return;
    }
    if (!avatarTempPath) {
      wx.showToast({ title: '请先选择头像', icon: 'none' });
      return;
    }

    this.setData({ loading: true });
    wx.showLoading({ title: '注册中...' });

    // 用于失败回滚
    let uploadedFileID = '';

    try {
      // 可选：wx.login 用于你后端 code2session 校验，这里不强依赖
      try { await wx.login(); } catch (_) {}

      // 1) 上传头像到云存储（根据临时路径动态取后缀）
      const suffix = (() => {
        const m = avatarTempPath.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i);
        return m ? m[0].toLowerCase() : '.jpg';
      })();
      const cloudPath = `avatars/${Date.now()}-${Math.floor(Math.random() * 1e6)}${suffix}`;
      const upRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: avatarTempPath
      });
      const avatarFileID = upRes.fileID;
      uploadedFileID = avatarFileID;

      // 2) 调用云函数（名称与你的实际一致：如果你用的是 registerUser，请把 name 换成 'registerUser'）
      const callRes = await wx.cloud.callFunction({
        name: 'login', // ← 若你的云函数名是 registerUser，请改成 'registerUser'
        data: {
          nickname,
          avatarFileID  // 统一传 fileID，后续 getTempFileURL 再转 https
        }
      });

      const r = callRes && callRes.result ? callRes.result : {};
      if (!r.success) {
        throw new Error(r.message || '注册失败，请稍后再试');
      }

      // ★★★ 兼容不同返回字段名 ★★★
      const uid         = r.userId || r.id || '';
      const openid      = r.openid || '';
      const nickSaved   = r.nickname || nickname;          // 后端可能未回传昵称，用本地的兜底
      const avatarSaved = r.avatarFileID || avatarFileID;  // 后端可能不回传，沿用刚上传的

      if (!openid) {
        // 强约束：没有 openid 基本等于失败
        throw new Error('注册失败：未获取到 openid');
      }

      // 3) 本地持久化（用统一字段，其他页面直接读）
      wx.setStorageSync('user', {
        _id: uid,               // 兼容你后续按 _id 读写
        userId: uid,            // 兼容你其他页面用 userId 的写法
        openid,                 // 供后续权限/查询
        nickname: nickSaved,
        avatar: avatarSaved     // 存 fileID，展示时再 getTempFileURL
      });

      wx.showToast({ title: '注册成功', icon: 'success' });

      // 4) 注册成功后，直接当作已登录用户，跳到首页
      //    不再返回登录页
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' });
      }, 800);

    } catch (err) {
      console.error('[register] error:', err);

      // 失败回滚：删除刚上传的头像，避免云端留下孤儿文件
      if (uploadedFileID) {
        try { await wx.cloud.deleteFile({ fileList: [uploadedFileID] }); } catch (_) {}
      }

      wx.showToast({ title: String(err.message || err), icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  // 返回
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.switchTab({ url: '/pages/index/index' });
  }
});
