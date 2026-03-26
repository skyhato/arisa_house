// app.js
App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({ env: 'cloud1-5gpzszjh5b3c4a84', traceUser: true });
    }
    // 方便其它页快速读取
    try {
      this.globalData = this.globalData || {};
      this.globalData.openid = wx.getStorageSync('openid') || '';
      this.globalData.user   = wx.getStorageSync('user')   || null;
    } catch {}
  },
  globalData: { openid: '', user: null }
});
