// pages/activity_detail/activity_detail.js
// 活动详细页：展示活动信息 + 活动下的已审核作品列表（分页 + 点赞 + 排序 + 角色筛选）
// 右下角三个按钮严格复刻列表页：排序 / 筛选 / 发布
//
// 依赖集合：activities, publish, roles
// 依赖云函数：toggleLike

const COLLECTION_ACTIVITIES = 'activities';
const COLLECTION_PUBLISH    = 'publish';
const COLLECTION_ROLES      = 'roles';

const PAGE_SIZE = 20;

// 角色缓存（与首页/发布页/排行榜共用风格）
const ROLES_CACHE_KEY = 'roles_cache_v1';
const ROLES_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

Page({
  data: {
    activityId: '',
    activityName: '活动',

    // 弹窗说明图
    showGuide: true,
    guideImg: 'cloud://cloud1-5gpzszjh5b3c4a84.636c-cloud1-5gpzszjh5b3c4a84-1385178608/images/activity_guide.png',

    // 列表数据
    items: [],
    _allItems: [],
    loading: false,

    // 分页
    pageSize: PAGE_SIZE,
    page: 0,
    totalApproved: 0,
    hasMore: true,

    // 角色筛选（和列表页一样：UI 按 id 勾选，但 DB 用 roleNames in()）
    roleList: [],
    checkedRoleIdSet: {},
    showFilterPanel: false,

    // 排序（和列表页一样）
    currentSort: 'likes7d', // likes7d / likes / time / random
    showSortPanel: false,

    defaultThumb: '../../assets/default-avatar.png',
    myOpenId: ''
  },

  onLoad(options) {
    const activityId = String(options.activityId || '');
    if (!activityId) {
      wx.showToast({ title: '缺少活动ID', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }

    const user = wx.getStorageSync('user') || {};
    const myOpenId = user.openid || user.openId || '';

    this.setData({ activityId, myOpenId }, async () => {
      await this.loadActivityInfo();
      await this.loadRoles();
      await this.loadApprovedInActivity({ force: true });
    });
  },

  onPullDownRefresh() {
    if (this.data.showFilterPanel || this.data.showSortPanel) {
      this.setData({ showFilterPanel: false, showSortPanel: false });
    }
    Promise.resolve()
      .then(() => this.loadApprovedInActivity({ force: true }))
      .finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.onLoadMore();
  },

  /* ================= 活动信息 ================= */

  async loadActivityInfo() {
    const db = wx.cloud.database();
    try {
      const res = await db.collection(COLLECTION_ACTIVITIES).doc(this.data.activityId).get();
      const a = res?.data || {};

      const name = (a.title || a.name || a.activityName || '活动').trim();

      // ✅ 新增：弹窗图改为 activities 里的 imgUrl（cloud:// 自动转临时链接）
      const rawGuide = (a.imgUrl || '').trim();
      let guideImg = this.data.guideImg; // 默认兜底：保持你原本的 guide 图
      if (rawGuide) {
        if (rawGuide.startsWith('cloud://')) {
          try {
            const map = await this._toTempUrls([rawGuide]);
            guideImg = map[rawGuide] || guideImg;
          } catch (e) {
            console.error('imgUrl 转临时链接失败', e);
          }
        } else {
          // 允许你直接填 https 等
          guideImg = rawGuide;
        }
      }

      this.setData({
        activityName: name || '活动',
        guideImg
      });

      wx.setNavigationBarTitle({ title: this.data.activityName });
    } catch (e) {
      console.error('loadActivityInfo error', e);
      wx.setNavigationBarTitle({ title: '活动' });
    }
  },

  /* ================= 工具 ================= */

  // 昵称打码：同你列表页
  _maskNickname(name) {
    if (!name || typeof name !== 'string') return '匿名用户';
    const s = name.trim();
    if (!s) return '匿名用户';
    const len = s.length;
    if (len === 1) return '*';
    if (len === 2) return '*' + s.charAt(1);
    return s.charAt(0) + '*'.repeat(len - 2) + s.charAt(len - 1);
  },

  async _toTempUrls(fileIds) {
    if (!fileIds || !fileIds.length) return {};
    const uniq = Array.from(new Set(
      fileIds.filter(id => typeof id === 'string' && id.startsWith('cloud://'))
    ));
    if (!uniq.length) return {};
    const { fileList } = await wx.cloud.getTempFileURL({ fileList: uniq });
    const map = {};
    (fileList || []).forEach(f => { map[f.fileID] = f.tempFileURL; });
    return map;
  },

  formatTime(ts) {
    if (!ts) return '';
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d)) return '';
    const y  = d.getFullYear();
    const m  = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const h  = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${dd} ${h}:${mm}`;
  },

  // 选中的角色「名字」数组（用于 DB roleNames 过滤）
  _getActiveRoleNames() {
    const set = this.data.checkedRoleIdSet || {};
    const ids = Object.keys(set).filter(id => set[id]).map(String);
    if (!ids.length) return [];
    const id2name = new Map(
      (this.data.roleList || []).map(r => [String(r.id || r._id), (r.name || r.roleName || '').trim()])
    );
    return ids.map(id => id2name.get(id)).filter(Boolean);
  },

  // 选中的角色 id（仅用于前端兜底过滤/UI）
  _getActiveRoleIds() {
    const set = this.data.checkedRoleIdSet || {};
    return Object.keys(set).filter(id => set[id]).map(String);
  },

  /* ================= 角色加载（同列表页逻辑） ================= */

  async loadRoles() {
    try {
      const now = Date.now();
      const cached = wx.getStorageSync(ROLES_CACHE_KEY);
      if (cached && cached.time && (now - cached.time) < ROLES_CACHE_TTL && Array.isArray(cached.roles)) {
        this.setData({ roleList: cached.roles });
        return;
      }
      const db = wx.cloud.database();
      const res = await db.collection(COLLECTION_ROLES).orderBy('order', 'asc').get();
      const roles = (res.data || []).map(r => ({
        id: String(r._id || r.id),
        name: r.name || r.roleName || '未命名角色'
      }));
      this.setData({ roleList: roles });
      wx.setStorageSync(ROLES_CACHE_KEY, { time: now, roles });
    } catch (e) {
      console.error('加载角色失败', e);
      this.setData({ roleList: [] });
    }
  },

  /* ================= 查询：计数 & 分页（活动内） ================= */

  async _countApprovedInActivity(sortMode) {
    const db = wx.cloud.database();
    const _  = db.command;

    const names = this._getActiveRoleNames();
    const where = names.length
      ? { status: 'APPROVED', activityId: this.data.activityId, roleNames: _.in(names) }
      : { status: 'APPROVED', activityId: this.data.activityId };

    if (sortMode === 'likes7d') {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      where.createdAt = _.gte(cutoff);
    }

    const res = await db.collection(COLLECTION_PUBLISH).where(where).count();
    return res.total || 0;
  },

  async _fetchApprovedPageInActivity(skip, limit, sortMode) {
    const db = wx.cloud.database();
    const _  = db.command;

    const names = this._getActiveRoleNames();
    const where = names.length
      ? { status: 'APPROVED', activityId: this.data.activityId, roleNames: _.in(names) }
      : { status: 'APPROVED', activityId: this.data.activityId };

    if (sortMode === 'likes7d') {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      where.createdAt = _.gte(cutoff);
    }

    let q = db.collection(COLLECTION_PUBLISH).where(where);

    if (sortMode === 'likes' || sortMode === 'likes7d') {
      q = q.orderBy('likesCount', 'desc').orderBy('_id', 'desc');
    } else {
      q = q.orderBy('createdAt', 'desc').orderBy('_id', 'desc');
    }

    const res = await q
      .skip(skip)
      .limit(limit)
      .field({
        thumbUrl: true,
        thumbFileID: true,
        originFileID: true,

        nickname: true,
        avatarUrl: true,
        avatar: true,
        avatarFileID: true,

        locationName: true,
        message: true,
        roleIds: true,
        roleNames: true,

        likedBy: true,
        likesCount: true,

        createdAt: true
      })
      .get();

    return res.data || [];
  },

  async _normalizePublishList(rawList) {
    if (!rawList || !rawList.length) return [];

    const cloudIds = [];
    rawList.forEach(p => {
      if (!p.thumbUrl) {
        const fid = (typeof p.thumbFileID === 'string' && p.thumbFileID.startsWith('cloud://') && p.thumbFileID)
                 || (typeof p.originFileID === 'string' && p.originFileID.startsWith('cloud://') && p.originFileID)
                 || '';
        if (fid) cloudIds.push(fid);
      }
      if (!p.avatarUrl) {
        const fid = (typeof p.avatar === 'string' && p.avatar.startsWith('cloud://') && p.avatar)
                 || (typeof p.avatarFileID === 'string' && p.avatarFileID.startsWith('cloud://') && p.avatarFileID)
                 || '';
        if (fid) cloudIds.push(fid);
      }
    });

    const id2url = cloudIds.length ? await this._toTempUrls(cloudIds) : {};
    const myOpenId = this.data.myOpenId;

    return rawList.map(p => {
      let thumbUrl = p.thumbUrl || '';
      if (!thumbUrl) {
        const fid = p.thumbFileID || p.originFileID || '';
        if (typeof fid === 'string' && fid.startsWith('cloud://')) thumbUrl = id2url[fid] || '';
      }

      let avatarUrl = p.avatarUrl || '';
      if (!avatarUrl) {
        const fid = p.avatar || p.avatarFileID || '';
        if (typeof fid === 'string' && fid.startsWith('cloud://')) avatarUrl = id2url[fid] || '';
      }

      const rawNickname = (p.nickname && String(p.nickname)) || '匿名用户';
      const nickname = this._maskNickname(rawNickname);

      const rawTs = p.createdAt || null;
      let tsNum = 0;
      if (rawTs) {
        if (rawTs instanceof Date) tsNum = rawTs.getTime();
        else if (typeof rawTs === 'number') tsNum = rawTs;
        else if (typeof rawTs === 'object' && rawTs.toDate) {
          try { tsNum = rawTs.toDate().getTime(); } catch (_) {}
        } else if (typeof rawTs === 'string') {
          const d = new Date(rawTs);
          if (!isNaN(d)) tsNum = d.getTime();
        }
      }

      const likedBy = Array.isArray(p.likedBy) ? p.likedBy.map(String) : [];
      const likesCount = Number(p.likesCount != null ? p.likesCount : likedBy.length);
      const hasLiked = myOpenId ? likedBy.includes(myOpenId) : false;

      return {
        id: String(p._id || p.id),
        thumbUrl,
        avatarUrl,
        nickname,
        locationName: p.locationName || '',
        message: p.message || '',
        roleIds: Array.isArray(p.roleIds) ? p.roleIds.map(String) : [],
        roleNames: Array.isArray(p.roleNames) ? p.roleNames : [],
        likesCount,
        hasLiked,
        createdAtText: this.formatTime(rawTs),
        createdAtTs: tsNum
      };
    });
  },

  /* ================= 加载流程（同列表页） ================= */

  async loadApprovedInActivity(options = {}) {
    const { force = false } = options;
    const sortMode = this.data.currentSort;

    // 应用筛选/切换排序 -> 先清空
    this.setData({
      loading: true,
      page: 0,
      totalApproved: 0,
      hasMore: true,
      items: [],
      _allItems: []
    });

    try {
      wx.showLoading({ title: '加载中...' });

      const total = await this._countApprovedInActivity(sortMode);
      if (!total) {
        this.setData({ totalApproved: 0, hasMore: false, items: [], _allItems: [] });
        return;
      }

      const raw = await this._fetchApprovedPageInActivity(0, this.data.pageSize, sortMode);
      let filled = await this._normalizePublishList(raw);
      if (sortMode === 'random') filled = this._shuffleArray(filled);

      this.setData({
        totalApproved: total,
        page: 1,
        hasMore: filled.length < total,
        _allItems: filled
      }, () => this._refreshFromAll());
    } catch (e) {
      console.error('loadApprovedInActivity error', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  async onLoadMore() {
    if (this.data.loading || !this.data.hasMore) return;

    const { page, pageSize, totalApproved, currentSort } = this.data;
    const skip = page * pageSize;
    if (skip >= totalApproved) {
      this.setData({ hasMore: false });
      return;
    }

    this.setData({ loading: true });
    wx.showLoading({ title: '加载中...' });

    try {
      const raw = await this._fetchApprovedPageInActivity(skip, pageSize, currentSort);
      if (!raw.length) {
        this.setData({ hasMore: false });
      } else {
        let filled = await this._normalizePublishList(raw);
        if (currentSort === 'random') filled = this._shuffleArray(filled);

        const merged = this.data._allItems.concat(filled);
        const hasMore = merged.length < this.data.totalApproved;

        this.setData({ _allItems: merged, page: page + 1, hasMore }, () => this._refreshFromAll());
      }
    } catch (e) {
      console.error('加载更多失败', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  // 从 _allItems 生成 items：只做兜底过滤（同列表页）
  _refreshFromAll() {
    let all = [...(this.data._allItems || [])];

    const wantNames = this._getActiveRoleNames();
    if (wantNames.length) {
      const ids = this._getActiveRoleIds();
      all = all.filter(it => {
        const nms = Array.isArray(it.roleNames) ? it.roleNames : [];
        if (nms.some(n => wantNames.includes(n))) return true;
        const its = Array.isArray(it.roleIds) ? it.roleIds.map(String) : [];
        return ids.length ? its.some(x => ids.includes(x)) : false;
      });
    }

    this.setData({ items: all });
  },

  _shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  /* ================= 点赞 / 跳转（同列表页） ================= */

  goPhoto(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) {
      wx.showToast({ title: '缺少作品ID', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/photo/photo?photoId=${id}` });
  },

  async likeWork(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;

    const user = wx.getStorageSync('user') || {};
    const myOpenId = user.openid || user.openId || '';
    if (!myOpenId) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }

    const idx = this.data.items.findIndex(x => x.id === id);
    if (idx === -1) {
      wx.showToast({ title: '未找到作品', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...', mask: true });
    try {
      const resp = await wx.cloud.callFunction({ name: 'toggleLike', data: { photoId: id } });
      const r = resp?.result || {};
      if (!r.ok) {
        wx.showToast({ title: r.msg || '操作失败', icon: 'none' });
        return;
      }

      const all = [...this.data._allItems];
      const aIdx = all.findIndex(x => x.id === id);
      if (aIdx !== -1) {
        all[aIdx] = { ...all[aIdx], hasLiked: r.liked, likesCount: r.likesCount };
      }
      this.setData({ _allItems: all }, () => this._refreshFromAll());

      wx.showToast({ title: r.liked ? '已点赞' : '已取消', icon: 'success' });
    } catch (err) {
      console.error('toggleLike error:', err);
      wx.showToast({ title: '网络异常', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ✅ 右下角：发布（带活动信息，发布页自动选中）
  goToPublish() {
    this.setData({ showFilterPanel: false, showSortPanel: false });

    const { activityId, activityName } = this.data;
    wx.navigateTo({
      url: `/pages/publish/publish?activityId=${encodeURIComponent(activityId)}&activityName=${encodeURIComponent(activityName)}`
    });
  },

  /* ================== 三按钮：筛选 / 排序（严格同列表页） ================== */

  openFilter() {
    this.setData({ showFilterPanel: true, showSortPanel: false });
  },
  closeFilter() { this.setData({ showFilterPanel: false }); },

  openSortPanel() { this.setData({ showSortPanel: true, showFilterPanel: false }); },
  closeSortPanel() { this.setData({ showSortPanel: false }); },

  closePanels() { this.setData({ showFilterPanel: false, showSortPanel: false }); },

  toggleRole(e) {
    const roleId = String(e.currentTarget.dataset.roleId);
    const set = { ...this.data.checkedRoleIdSet };
    if (set[roleId]) delete set[roleId];
    else set[roleId] = true;
    this.setData({ checkedRoleIdSet: set });
  },

  resetFilter() {
    this.setData({ checkedRoleIdSet: {} }, () => this.loadApprovedInActivity({ force: true }));
  },

  applyFilter() {
    this.closeFilter();
    this.loadApprovedInActivity({ force: true });
  },

  setSort(e) {
    const value = e.currentTarget.dataset.value || 'likes7d';
    if (value === this.data.currentSort) return this.closeSortPanel();
    this.setData({ currentSort: value }, () => {
      this.closeSortPanel();
      this.loadApprovedInActivity({ force: true });
    });
  },

  noop() {},

  /* ================== 说明图弹窗 ================== */

  closeGuide() {
    this.setData({ showGuide: false });
  }
});
