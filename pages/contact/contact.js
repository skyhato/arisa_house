// pages/contact/contact.js
const COLLECTION_CONFIG = 'app_config';

Page({
  data: {
    showImage: true   // 默认显示，拉到 false 时隐藏
  },

  async onLoad() {
    try {
      const db = wx.cloud.database();
      const { data } = await db.collection(COLLECTION_CONFIG).limit(1).get();

      const cfg = data && data.length ? data[0] : {};
      const enabled = cfg.commentEnabled;  // true / false

      this.setData({
        showImage: !!enabled   // 为 false 时，隐藏图片
      });
    } catch (e) {
      // 拉失败时默认显示，不让页面空白
      this.setData({ showImage: true });
    }
  },

  onBackTap() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({
        url: '/pages/index/index',
      });
    }
  }
});
