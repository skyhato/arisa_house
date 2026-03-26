Page({
  data: { loading: false },

  async onWeixinLogin() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    wx.showLoading({ title: '登录中...' });

    try {
      await wx.login();
      const ret = await wx.cloud.callFunction({ name: 'checkUser' });
      const res = ret.result || {};
      console.log('checkUser 返回:', res);

      if (res && typeof res.found === 'boolean') {
        if (res.found) {
          wx.setStorageSync('user', {
            openid: res.openid,
            userId: res.userId,
            nickname: res.nickname,
            avatar: res.avatarFileID
          });
          wx.showToast({ title: '欢迎回来' });
          const pages = getCurrentPages();
          if (pages.length > 1) {
            wx.navigateBack();
          } else {
            wx.switchTab({ url: '/pages/index/index' });
          }
        } else {
          wx.navigateTo({ url: '/pages/register/register' });
        }
        return;
      }

      if (res && res.openid) {
        wx.navigateTo({ url: '/pages/register/register' });
        return;
      }

      wx.showToast({ title: '登录失败：无效返回', icon: 'none' });
    } catch (e) {
      console.error('[login] error:', e);
      wx.showToast({ title: String(e.message || e), icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  onLogout() {
    wx.removeStorageSync('user');
    wx.showToast({ title: '已清除登录状态' });
  }
});
