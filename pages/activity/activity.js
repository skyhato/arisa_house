// pages/activity/activity.js
const COLLECTION_ACTIVITIES = 'activities';
const PAGE_SIZE = 20;

Page({
  data: {
    list: [],
    loading: false,
    hasMore: true,
    _skip: 0,
  },

  onLoad() {
    this.loadActivities(true);
  },

  onPullDownRefresh() {
    this.loadActivities(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.loading || !this.data.hasMore) return;
    this.loadActivities(false);
  },

  async loadActivities(reset = false) {
    if (this.data.loading) return;
    this.setData({ loading: true });

    const db = wx.cloud.database();
    const _ = db.command;
    const skip = reset ? 0 : (this.data._skip || 0);

    // 当前时间（本机时间）
    const now = new Date();

    try {
      const res = await db.collection(COLLECTION_ACTIVITIES)
        .where({
          // 如果你启用了 enabled 字段，这行保留；不需要就删掉
          enabled: true,

          // ✅ 只取“正在进行中”的活动：startTime <= now <= endTime
          startTime: _.lte(now),
          endTime: _.gte(now),
        })
        .orderBy('startTime', 'desc')
        .skip(skip)
        .limit(PAGE_SIZE)
        .get();

      const rows = res.data || [];
      const mapped = rows.map(r => this._mapRow(r)).filter(Boolean);

      const nextList = reset ? mapped : (this.data.list.concat(mapped));
      const hasMore = rows.length === PAGE_SIZE;

      this.setData({
        list: nextList,
        hasMore,
        _skip: skip + rows.length,
      });
    } catch (e) {
      console.warn('[activity] load failed:', e);
      if (reset) this.setData({ list: [], hasMore: false, _skip: 0 });
      wx.showToast({ title: '活动加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  _mapRow(row) {
    if (!row) return null;

    const id = String(row._id || row.id || '');
    if (!id) return null;

    const name = (row.name || row.title || row.activityName || '未命名活动').toString();

    const coverUrl =
      row.imageUrl ||
      row.coverUrl ||
      row.cardUrl ||
      row.image ||
      row.fileID ||
      row.fileId ||
      '';

    const startRaw = row.startTime || row.start || row.beginTime || row.begin;
    const endRaw = row.endTime || row.end || row.finishTime || row.finish;

    // ✅ 再兜底一次：start/end 缺失或解析失败，直接不显示
    const start = this._toDate(startRaw);
    const end = this._toDate(endRaw);
    if (!start || !end) return null;

    // ✅ 再兜底一次：不在时间范围内，不显示
    const now = Date.now();
    if (now < start.getTime() || now > end.getTime()) return null;

    const startText = this._fmtDateTime(start);
    const endText = this._fmtDateTime(end);

    const timeText = `${startText} ~ ${endText}`;

    return {
      id,
      name,
      coverUrl,
      start,
      end,
      timeText,
    };
  },

  _toDate(v) {
    if (!v) return null;

    let d = null;

    if (v instanceof Date) {
      d = v;
    } else if (typeof v === 'number') {
      d = new Date(v);
    } else if (typeof v === 'string') {
      const s = v.replace(/-/g, '/');
      d = new Date(s);
    } else if (typeof v === 'object' && typeof v.toDate === 'function') {
      d = v.toDate(); // 云数据库 Date 类型
    }

    if (!d || isNaN(d.getTime())) return null;
    return d;
  },

  _fmtDateTime(v) {
    if (!v) return '';

    let d = v instanceof Date ? v : this._toDate(v);
    if (!d) return '';

    const pad = (n) => String(n).padStart(2, '0');
    const Y = d.getFullYear();
    const M = pad(d.getMonth() + 1);
    const D = pad(d.getDate());
    const h = pad(d.getHours());
    const m = pad(d.getMinutes());
    return `${Y}-${M}-${D} ${h}:${m}`;
  },

  // ✅ 卡片点击：带参跳转（严格传 activityId）
  onCardTap(e) {
    const id = String(e.currentTarget?.dataset?.id || '');
    if (!id) {
      wx.showToast({ title: '缺少活动ID', icon: 'none' });
      return;
    }

    wx.navigateTo({
      url: `/pages/activity_detail/activity_detail?activityId=${encodeURIComponent(id)}`
    });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages && pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.reLaunch({ url: '/pages/index/index' });
    }
  },
});
