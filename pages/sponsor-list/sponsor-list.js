// pages/sponsor-list/sponsor-list.js
const COLLECTION_SPONSORS = 'sponsors';

Page({
  data: {
    records: []
  },

  onLoad() {
    this.loadSponsorRecords();
  },

  async loadSponsorRecords() {
    const db = wx.cloud.database();
    try {
      const res = await db.collection(COLLECTION_SPONSORS)
        // 你现在没有 createTime 字段了，所以改用 timeText 排序
        .orderBy('timeText', 'desc')
        .get();

      const records = (res.data || []).map(item => ({
        id: item._id,
        name: item.name || '匿名用户',
        amount: item.amount || 0,
        // 你现在只存了 timeText（例如 "2025-11-10"）
        time: item.timeText || ''
      }));

      this.setData({ records });
      console.log('[sponsor-list] records:', records);
    } catch (e) {
      console.error('[sponsor-list] load error', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onBackTap() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/my/my' });
      }
    });
  }
});
