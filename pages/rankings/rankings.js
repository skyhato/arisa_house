// pages/rankings/rankings.js
// 排行榜：仅展示已审核( status='APPROVED' )，可筛选、可点赞（云函数 toggleLike）
//
// 新增：近 7 天点赞排序（实现为：仅统计“近 7 天发布”的作品，再按 likesCount 排序）
// 默认排序：近 7 天点赞排序

const COLLECTION_PUBLISH = 'publish';
const COLLECTION_ROLES   = 'roles';

// 角色缓存（与首页/发布页共用）
const ROLES_CACHE_KEY = 'roles_cache_v1';
const ROLES_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// 仅缓存“默认视图”（近7天点赞排序+无筛选）
const RANKINGS_CACHE_KEY = 'rankings_cache_v2';
const RANKINGS_CACHE_TTL = 60 * 1000; // 60s

Page({
  data: {
    items: [],
    _allItems: [],
    loading: false,

    // 分页
    pageSize: 20,
    page: 0,
    totalApproved: 0,
    hasMore: true,

    // 角色筛选（UI 仍按 id 勾选）
    roleList: [],
    checkedRoleIdSet: {},
    showFilterPanel: false,

    // 排序
    currentSort: 'likes7d', // likes7d / likes / time / random
    showSortPanel: false,

    defaultThumb: '../../assets/default-avatar.png',
    myOpenId: ''
  },

  // 昵称打码：只取前后两个字，如果只有两个字就只保留后一个字，其他用 * 隐藏
  _maskNickname(name) {
    if (!name || typeof name !== 'string') return '匿名用户';
    const s = name.trim();
    if (!s) return '匿名用户';

    const len = s.length;
    if (len === 1) {
      // 只有一个字：全打码
      return '*';
    }
    if (len === 2) {
      // 只有两个字：只保留后一个字
      return '*' + s.charAt(1);
    }
    // 三个及以上：保留首尾，其余用 *
    const first = s.charAt(0);
    const last  = s.charAt(len - 1);
    const middle = '*'.repeat(len - 2);
    return first + middle + last;
  },

  onLoad() {
    const user = wx.getStorageSync('user') || {};
    const myOpenId = user.openid || user.openId || '';
    this.setData({ myOpenId });

    this.loadRoles();
    this.loadApprovedRankings();
  },

  /* ============= 工具 ============= */

  // 选中的角色「名字」数组（用于 DB 的 roleNames 字段过滤）
  _getActiveRoleNames() {
    const set = this.data.checkedRoleIdSet || {};
    const ids = Object.keys(set).filter(id => set[id]).map(String);
    if (ids.length === 0) return [];

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

  /* ============= 统计 & 分页查询（改用 where + orderBy） ============= */

  // 命中：
  //  - 无筛选：idx_status_likes_desc / idx_status_created_desc
  //  - 有筛选：idx_status_roleNames_likes_desc / idx_status_roleNames_created_desc
  async _countApproved(sortMode) {
    const db = wx.cloud.database();
    const _  = db.command;

    const names = this._getActiveRoleNames();
    const where = names.length
      ? { status: 'APPROVED', roleNames: _.in(names) }
      : { status: 'APPROVED' };

    // 近7天热榜：仅取近7天发布的作品
    if (sortMode === 'likes7d') {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      where.createdAt = _.gte(cutoff);
    }

    // 用 count() 即可，不需要 aggregate
    const res = await db.collection(COLLECTION_PUBLISH).where(where).count();
    return res.total || 0;
  },

  // 真正分页查询：where + orderBy + skip + limit
  async _fetchApprovedPage(skip, limit, sortMode) {
    const db = wx.cloud.database();
    const _  = db.command;

    const names = this._getActiveRoleNames();
    const where = names.length
      ? { status: 'APPROVED', roleNames: _.in(names) }
      : { status: 'APPROVED' };

    // 近7天热榜：仅取近7天发布的作品
    if (sortMode === 'likes7d') {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      where.createdAt = _.gte(cutoff);
    }

    let q = db.collection(COLLECTION_PUBLISH).where(where);

    if (sortMode === 'likes' || sortMode === 'likes7d') {
      // 命中：
      //  - 无筛选：建议建 idx_status_likes_desc（status, likesCount, _id）
      //  - 有筛选：命中 idx_status_roleNames_likes_desc
      q = q.orderBy('likesCount', 'desc').orderBy('_id', 'desc');
    } else {
      // 时间排序完全按 createdAt 来（你所有数据都有 createdAt）
      // 无筛选：idx_status_created_desc
      // 有筛选：idx_status_roleNames_created_desc
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

  /* ============= 数据标准化 ============= */

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
        if (typeof fid === 'string' && fid.startsWith('cloud://')) {
          thumbUrl = id2url[fid] || '';
        }
      }

      let avatarUrl = p.avatarUrl || '';
      if (!avatarUrl) {
        const fid = p.avatar || p.avatarFileID || '';
        if (typeof fid === 'string' && fid.startsWith('cloud://')) {
          avatarUrl = id2url[fid] || '';
        }
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

  /* ============= 加载流程 ============= */

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

  async loadApprovedRankings(options = {}) {
    const { force = false } = options;
    const sortMode = this.data.currentSort;

    // “应用筛选/切换排序”时先清空，避免旧数据残留
    this.setData({
      loading: true,
      page: 0,
      totalApproved: 0,
      hasMore: true,
      items: [],
      _allItems: []
    });

    try {
      const now = Date.now();
      const names = this._getActiveRoleNames();

      // 只有“默认视图”（近7天点赞+无筛选）才读缓存
      const canUseCache = !force && sortMode === 'likes7d' && names.length === 0;
      if (canUseCache) {
        const cache = wx.getStorageSync(RANKINGS_CACHE_KEY);
        if (cache && cache.time && (now - cache.time) < RANKINGS_CACHE_TTL && Array.isArray(cache.allItems)) {
          this.setData({
            _allItems: cache.allItems,
            totalApproved: cache.totalApproved || cache.allItems.length,
            page: cache.page || 1,
            hasMore: typeof cache.hasMore === 'boolean' ? cache.hasMore :
              (cache.allItems.length < (cache.totalApproved || cache.allItems.length))
          }, () => this._refreshFromAll());
          this.setData({ loading: false });
          return;
        }
      }

      wx.showLoading({ title: '加载中...' });

      const total = await this._countApproved(sortMode);
      if (!total) {
        this.setData({ totalApproved: 0, hasMore: false, items: [], _allItems: [] });
        return;
      }

      const raw = await this._fetchApprovedPage(0, this.data.pageSize, sortMode);
      let filled = await this._normalizePublishList(raw);
      if (sortMode === 'random') filled = this._shuffleArray(filled);

      this.setData({
        totalApproved: total,
        page: 1,
        hasMore: filled.length < total,
        _allItems: filled
      }, () => this._refreshFromAll());

      if (sortMode === 'likes7d' && names.length === 0) {
        wx.setStorageSync(RANKINGS_CACHE_KEY, {
          time: Date.now(),
          allItems: this.data._allItems,
          totalApproved: this.data.totalApproved,
          page: this.data.page,
          hasMore: this.data.hasMore
        });
      }
    } catch (e) {
      console.error('加载排行榜失败', e);
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
      const raw = await this._fetchApprovedPage(skip, pageSize, currentSort);
      if (!raw.length) {
        this.setData({ hasMore: false });
      } else {
        let filled = await this._normalizePublishList(raw);
        if (currentSort === 'random') filled = this._shuffleArray(filled);

        const merged = this.data._allItems.concat(filled);
        const hasMore = merged.length < this.data.totalApproved;

        this.setData({ _allItems: merged, page: page + 1, hasMore }, () => this._refreshFromAll());

        const names = this._getActiveRoleNames();
        if (currentSort === 'likes7d' && names.length === 0) {
          wx.setStorageSync(RANKINGS_CACHE_KEY, {
            time: Date.now(),
            allItems: this.data._allItems,
            totalApproved: this.data.totalApproved,
            page: this.data.page,
            hasMore: this.data.hasMore
          });
        }
      }
    } catch (e) {
      console.error('加载更多失败', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  /* ============= 点赞 / 跳转 ============= */

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

      const names = this._getActiveRoleNames();
      if (this.data.currentSort === 'likes7d' && names.length === 0) {
        wx.setStorageSync(RANKINGS_CACHE_KEY, {
          time: Date.now(),
          allItems: this.data._allItems,
          totalApproved: this.data.totalApproved,
          page: this.data.page,
          hasMore: this.data.hasMore
        });
      }
      wx.showToast({ title: r.liked ? '已点赞' : '已取消', icon: 'success' });
    } catch (err) {
      console.error('toggleLike error:', err);
      wx.showToast({ title: '网络异常', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  goPhoto(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) {
      wx.showToast({ title: '缺少作品ID', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/photo/photo?photoId=${id}` });
  },

  goToPublish() {
    this.setData({ showFilterPanel: false, showSortPanel: false });
    wx.navigateTo({ url: '/pages/publish/publish' });
  },

  /* ============= 筛选 / 排序 ============= */

  openFilter() {
    this.setData({ showFilterPanel: true, showSortPanel: false });
  },
  closeFilter() { this.setData({ showFilterPanel: false }); },

  toggleRole(e) {
    const roleId = String(e.currentTarget.dataset.roleId);
    const set = { ...this.data.checkedRoleIdSet };
    if (set[roleId]) delete set[roleId];
    else set[roleId] = true;
    this.setData({ checkedRoleIdSet: set });
  },

  resetFilter() {
    this.setData({ checkedRoleIdSet: {} }, () => this.loadApprovedRankings({ force: true }));
  },

  applyFilter() {
    this.closeFilter();
    this.loadApprovedRankings({ force: true });
  },

  openSortPanel() { this.setData({ showSortPanel: true, showFilterPanel: false }); },
  closeSortPanel() { this.setData({ showSortPanel: false }); },
  closePanels() { this.setData({ showFilterPanel: false, showSortPanel: false }); },

  setSort(e) {
    const value = e.currentTarget.dataset.value || 'likes7d';
    if (value === this.data.currentSort) return this.closeSortPanel();
    this.setData({ currentSort: value }, () => {
      this.closeSortPanel();
      this.loadApprovedRankings({ force: true });
    });
  },

  // 由 _allItems 生成 items：这里不再改动排序顺序，只做兜底过滤
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

  /* ============= 时间 & 下拉刷新 ============= */

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

  onPullDownRefresh() {
    if (this.data.showFilterPanel || this.data.showSortPanel) {
      this.setData({ showFilterPanel: false, showSortPanel: false });
    }
    Promise.resolve()
      .then(() => this.loadApprovedRankings({ force: true }))
      .finally(() => wx.stopPullDownRefresh());
  },

  noop() {}
});
