// pages/notice/notice.js
// 合并通知：点赞 + 评论（评论来自 comments 集合，筛选“评论在我的作品上”）
const PAGE_SIZE = 20;   // ✅ 每次加载 20 条

// ====== 本地缓存（新加）======
const NOTICE_CACHE_KEY = 'notice_cache_v1';
const NOTICE_CACHE_TTL = 60 * 1000; // 60 秒内多次进入直接读缓存

// 🔴 跟“我的”页小红点共用的 key
const HAS_NEW_NOTICE_KEY = 'hasNewNotice';

Page({
  data: {
    items: [],
    defaultAvatar: '/assets/default-avatar.png',
    loading: true,
    loadingMore: false,
    hasMore: true,

    // 内部状态
    _myOpenid: null,
    _photoMap: {},      // { photoId: { thumbFileID } }
    _allMerged: [],     // 已合并（点赞+评论）后完整列表
    _mergedCursor: 0,   // 已展示数量

    // 点赞云函数的游标
    _likeCursor: 0
  },

  onLoad() {
    this.init();
  },

  async init() {
    const user = wx.getStorageSync('user');
    const myOpenid = user && (user.openid || user.openId);
    if (!myOpenid) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    this.setData({ _myOpenid: myOpenid });

    // 一进消息页就认为“已读”，清掉小红点（防止从别的入口进来时不同步）
    wx.setStorageSync(HAS_NEW_NOTICE_KEY, false);

    await this.reload();
  },

  // 核心：重新加载数据（首屏）
  async reload(options = {}) {
    const { force = false } = options;
    this.setData({
      loading: true,
      items: [],
      hasMore: true,
      loadingMore: false,
      _photoMap: {},
      _allMerged: [],
      _mergedCursor: 0,
      _likeCursor: 0
    });

    try {
      const now = Date.now();

      // ========== 1) 尝试走本地缓存（新加） ==========
      if (!force) {
        const cache = wx.getStorageSync(NOTICE_CACHE_KEY);
        if (
          cache &&
          cache.time &&
          (now - cache.time) < NOTICE_CACHE_TTL &&
          Array.isArray(cache.allMerged)
        ) {
          const merged = cache.allMerged;
          const photoMap = cache.photoMap || {};
          const likeCursor = cache.likeCursor || 0;

          const firstPage = merged.slice(0, PAGE_SIZE);
          const cursor = firstPage.length;
          const hasMore = cursor < merged.length;

          this.setData({
            _photoMap: photoMap,
            _allMerged: merged,
            _mergedCursor: cursor,
            _likeCursor: likeCursor,
            items: firstPage,
            hasMore
          });

          this.setData({ loading: false });
          console.log('[notice] 使用本地缓存，items =', firstPage.length);

          // 进到通知页 => 视为已读，清小红点（再保险一次）
          wx.setStorageSync(HAS_NEW_NOTICE_KEY, false);
          return;
        }
      }

      // ========== 2) 走服务器（原有逻辑） ==========
      // 1) 预取“我的作品” => 用于拿缩略图 & 过滤评论
      await this._buildMyPhotoMap();

      // 2) 取一页点赞通知（沿用你的云函数）
      const likes = await this._fetchLikesPage({ limit: PAGE_SIZE });

      // 3) 取评论（取最近的一批，数量留有余量，再由前端分页）
      const comments = await this._fetchCommentsBatch({ limit: 60 });

      // 4) 合并并按时间倒序
      const merged = likes.concat(comments).sort((a, b) => b.createdAt - a.createdAt);
      this.setData({ _allMerged: merged });

      // 5) 首屏分页输出
      this._appendNextPage();

      // 6) 写入本地缓存（新加）
      try {
        wx.setStorageSync(NOTICE_CACHE_KEY, {
          time: Date.now(),
          allMerged: merged,
          photoMap: this.data._photoMap,
          likeCursor: this.data._likeCursor
        });
      } catch (e) {
        console.warn('[notice] 写缓存失败', e);
      }

      // ✅ 用户已经在消息页了，此时默认认为这些消息已查看，清除小红点
      wx.setStorageSync(HAS_NEW_NOTICE_KEY, false);
    } catch (e) {
      console.error('[notice] reload failed:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
      this.setData({ hasMore: false });
    } finally {
      this.setData({ loading: false });
    }
  },

  // ✅ 原生：页面下拉刷新（强制跳过缓存）
  onPullDownRefresh() {
    // 这里当“用户真的想刷新”，强制从服务器重拉
    this.reload({ force: true })
      .catch(() => {})
      .finally(() => {
        wx.stopPullDownRefresh();
      });
  },

  // ✅ 点击“加载更多”按钮时触发
  async onLoadMoreTap() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true });

    try {
      // 如果当前已用尽，就再拉一页点赞 & 一批最新评论，然后再合并
      if (this.data._mergedCursor >= this.data._allMerged.length) {
        const extraLikes = await this._fetchLikesPage({ limit: PAGE_SIZE });
        const extraComments = await this._fetchCommentsBatch({ limit: 40 });
        const merged = this.data._allMerged
          .concat(extraLikes, extraComments)
          .sort((a, b) => b.createdAt - a.createdAt);

        this.setData({ _allMerged: merged });

        // 更新缓存（新加）：保证下一次进来，能看到包含“更多”的版本
        try {
          wx.setStorageSync(NOTICE_CACHE_KEY, {
            time: Date.now(),
            allMerged: merged,
            photoMap: this.data._photoMap,
            likeCursor: this.data._likeCursor
          });
        } catch (e) {
          console.warn('[notice] loadMore 写缓存失败', e);
        }
      }

      this._appendNextPage();

      // 加载更多也属于“继续看消息”，顺手清小红点（防止残留）
      wx.setStorageSync(HAS_NEW_NOTICE_KEY, false);
    } catch (e) {
      console.error('[notice] loadMore error:', e);
      wx.showToast({ title: '网络异常', icon: 'none' });
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  /* ================= 核心数据源 ================= */

  // 我发布过的作品 => { photoId: { thumbFileID } }
  async _buildMyPhotoMap() {
    const db = wx.cloud.database();
    const map = {};
    const LIMIT = 100;

    // 统计总数
    const countRes = await db.collection('publish')
      .where({ openid: this.data._myOpenid })
      .count();
    const total = countRes.total || 0;
    if (total === 0) {
      this.setData({ _photoMap: {} });
      return;
    }

    const rounds = Math.ceil(total / LIMIT);
    const tasks = [];
    for (let i = 0; i < rounds; i++) {
      tasks.push(
        db.collection('publish')
          .where({ openid: this.data._myOpenid })
          .skip(i * LIMIT)
          .limit(LIMIT)
          .field({
            _id: true,
            thumbFileID: true,
            thumbFileId: true,
            originFileID: true,
            originFileId: true
          })
          .get()
      );
    }

    const resultSets = await Promise.all(tasks);
    resultSets.forEach(r => {
      (r.data || []).forEach(doc => {
        const pid = String(doc._id || doc.id);
        const thumb =
          doc.thumbFileID ||
          doc.thumbFileId ||
          doc.originFileID ||
          doc.originFileId ||
          '';
        map[pid] = { thumbFileID: thumb };
      });
    });

    this.setData({ _photoMap: map });
  },

  // 点赞通知（沿用你的云函数）：返回统一格式
  async _fetchLikesPage({ limit = PAGE_SIZE } = {}) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'pullNotifications',
        data: {
          cursor: this.data._likeCursor,
          limit,
          markRead: true
        }
      });

      const r = res.result || {};
      if (!r.ok) return [];

      // 维护游标
      this.setData({
        _likeCursor: r.nextCursor || 0
      });

      const formatTime = this._formatTime.bind(this);

      return (r.items || []).map(it => ({

        id: it.id,
        type: 'like',
        actionText: '赞了你的作品',
        photoId: it.photoId,
        thumbFileID: it.thumbFileID,
        likerOpenid: it.likerOpenid,
        likerName: it.likerName,
        likerAvatar: it.likerAvatar,
        read: !!it.read,
        createdAt: Number(it.createdAt),
        timeText: formatTime(Number(it.createdAt))
      }));
    } catch (e) {
      console.warn('[notice] fetch likes fail:', e);
      return [];
    }
  },

  // 最近评论（取在“我的作品”下的评论）
  async _fetchCommentsBatch({ limit = 60 } = {}) {
    const db = wx.cloud.database();
    const _ = db.command;
    const photoIds = Object.keys(this.data._photoMap);
    if (photoIds.length === 0) return [];

    try {
      const res = await db.collection('comments')
        .where({ photoId: _.in(photoIds) })
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      const formatTime = this._formatTime.bind(this);

      return (res.data || []).map(c => {
        const pid = String(c.photoId);
        const thumb = this.data._photoMap[pid]?.thumbFileID || '';
        const createdAt = this._toTs(c.createdAt);

        return {
          id: String(c._id || c.id),
          type: 'comment',
          actionText: '评论了你的作品',
          photoId: pid,
          thumbFileID: thumb,
          likerOpenid: c._openid || c.openid || '',
          likerName: c.nickname || '匿名用户',
          likerAvatar: c.avatarUrl || '',
          content: c.content || '',
          read: !!c.read,            // 如果你没有 read 字段，就是 false
          createdAt,
          timeText: formatTime(createdAt)
        };
      });
    } catch (e) {
      console.warn('[notice] fetch comments fail:', e);
      return [];
    }
  },

  /* ================= 分页拼装 ================= */
  _appendNextPage() {
    const { _allMerged, _mergedCursor } = this.data;

    const nextSlice = _allMerged.slice(
      _mergedCursor,
      _mergedCursor + PAGE_SIZE
    );
    const newCursor = _mergedCursor + nextSlice.length;

    const newItems = this.data.items.concat(nextSlice);
    const hasMore = newCursor < _allMerged.length;

    this.setData({
      items: newItems,
      _mergedCursor: newCursor,
      hasMore
    });
  },

  /* ================= 工具 ================= */
  _toTs(v) {
    // 兼容 Date / 时间戳 / ISO 字符串
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : 0;
    }
    if (v && typeof v.getTime === 'function') return v.getTime();
    try {
      return new Date(v).getTime() || 0;
    } catch {
      return 0;
    }
  },

  _formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = Date.now();
    const diff = Math.max(0, now - d.getTime());
    const m = 60 * 1000,
      h = 60 * m,
      day = 24 * h;

    if (diff < m) return '刚刚';
    if (diff < h) return `${Math.floor(diff / m)}分钟前`;
    if (diff < day) return `${Math.floor(diff / h)}小时前`;

    const pad = n => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate()
    )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  onPreviewThumb(e) {
    e.stopPropagation();
    const src = e.currentTarget.dataset.src;
    if (src) {
      wx.previewImage({
        urls: [src],
        current: src
      });
    }
  },

  onCardTap(e) {
    const { photoid } = e.currentTarget.dataset || {};
    if (!photoid) return;
    wx.navigateTo({ url: `/pages/photo/photo?id=${photoid}` });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  }
});
