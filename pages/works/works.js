// pages/works/works.js
const MAX_ROLE_TAGS_2LINE = 6;        // 经验值：两行一般够放 5~7 个，取 6 稳
const LOAD_DEBOUNCE_MS = 250;         // 轻量去重：onLoad/onShow 连触发时只跑一次

Page({
  data: {
    works: [],
    loading: false,
    defaultThumb: '/assets/default-avatar.png'
  },

  // ====== 运行时状态（不进 data）======
  _loadingPromise: null,
  _loadTimer: null,

  onLoad() {
    this._debouncedCheckLoginAndLoad();
  },

  onShow() {
    this._debouncedCheckLoginAndLoad();
  },

  onPullDownRefresh() {
    // 下拉刷新：强制执行一次（不走 debounce），但仍做并发去重
    this.checkLoginAndLoad(true).finally(() => wx.stopPullDownRefresh());
  },

  /** 轻量防抖：避免 onLoad/onShow 重复触发造成重复请求 */
  _debouncedCheckLoginAndLoad() {
    if (this._loadTimer) clearTimeout(this._loadTimer);
    this._loadTimer = setTimeout(() => {
      this.checkLoginAndLoad(false);
    }, LOAD_DEBOUNCE_MS);
  },

  /** 登录检查并加载
   *  @param {boolean} force 是否强制刷新（下拉刷新用）
   */
  async checkLoginAndLoad(force = false) {
    // 并发去重：如果正在加载且不是强制刷新，直接复用同一个 promise
    if (this._loadingPromise && !force) return this._loadingPromise;

    const u = wx.getStorageSync('user') || {};
    const userId = u.userId || u._id || u.user_id || null;
    const openid = u.openid || u.openId || null;

    if (!userId && !openid) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }

    const p = this.loadWorks({ userId, openid })
      .finally(() => {
        // 结束后释放并发锁
        this._loadingPromise = null;
      });

    this._loadingPromise = p;
    return p;
  },

  /** fileID → 临时URL */
  async _batchToTempUrls(fileIds) {
    if (!Array.isArray(fileIds) || fileIds.length === 0) return {};
    const uniq = Array.from(new Set(
      fileIds.filter(id => typeof id === 'string' && id.startsWith('cloud://'))
    ));
    if (uniq.length === 0) return {};
    const { fileList } = await wx.cloud.getTempFileURL({ fileList: uniq });
    const map = {};
    (fileList || []).forEach(f => { map[f.fileID] = f.tempFileURL || ''; });
    return map;
  },

  /** 把 roleNames 解析为数组 */
  _parseRoleTags(roleNames) {
    let roleTags = [];
    if (Array.isArray(roleNames)) {
      roleTags = roleNames.filter(Boolean);
    } else if (typeof roleNames === 'string') {
      roleTags = roleNames
        .split(/[,，、\s]+/)
        .map(t => t.trim())
        .filter(Boolean);
    }
    // 去重（保序）
    const seen = new Set();
    roleTags = roleTags.filter(t => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    return roleTags;
  },

  /** 角色两行展示裁剪：生成 _roleTagsShow 和 _roleTagsMore */
  _buildRoleShow(roleTags) {
    const tags = Array.isArray(roleTags) ? roleTags : [];
    const more = tags.length > MAX_ROLE_TAGS_2LINE;
    return {
      _roleTagsMore: more,
      _roleTagsShow: more ? tags.slice(0, MAX_ROLE_TAGS_2LINE - 1) : tags
    };
  },

  /** 拉取我的作品（仅用 roleNames） */
  async loadWorks({ userId, openid }) {
    this.setData({ loading: true });
    wx.showLoading({ title: '加载中...' });

    const db = wx.cloud.database();
    const _ = db.command;

    try {
      const orConds = [];
      if (userId) {
        const s = String(userId), n = Number(s);
        orConds.push({ userId: s });
        if (!Number.isNaN(n)) orConds.push({ userId: n });
      }
      if (openid) {
        orConds.push({ _openid: openid });
        orConds.push({ userId: openid });
        orConds.push({ openid });
      }
      const whereCond = orConds.length ? _.or(orConds) : { _id: '__never__' };

      let res;
      try {
        res = await db.collection('publish')
          .where(whereCond)
          .orderBy('createdAt', 'desc')
          .get();
      } catch {
        res = await db.collection('publish')
          .where(whereCond)
          .orderBy('_id', 'desc')
          .get();
      }

      if (!res.data || res.data.length === 0) {
        this.setData({ works: [] });
        return;
      }

      // 图片临时链接
      const fids = [];
      res.data.forEach(w => {
        const t1 = w.thumbFileID || w.thumbFileId;
        const t2 = w.originFileID || w.originFileId;
        if (typeof t1 === 'string' && t1.startsWith('cloud://')) fids.push(t1);
        if (typeof t2 === 'string' && t2.startsWith('cloud://')) fids.push(t2);
      });
      const id2url = await this._batchToTempUrls(fids);

      const works = res.data.map(w => {
        const created  = w.createdAt || w.createTime || w.created_at || null;
        const thumbId  = w.thumbFileID  || w.thumbFileId || '';
        const originId = w.originFileID || w.originFileId || '';

        let thumbUrl = '';
        if (thumbId && thumbId.startsWith('cloud://')) thumbUrl = id2url[thumbId] || '';
        if (!thumbUrl && originId && originId.startsWith('cloud://')) thumbUrl = id2url[originId] || '';
        if (!thumbUrl) thumbUrl = this.data.defaultThumb;

        const rawStatus = (w.status || '').toString().toUpperCase();
        let statusText = '未审核';
        if (rawStatus === 'APPROVED') statusText = '已审核';
        else if (rawStatus === 'REJECTED') statusText = '已驳回';

        // ✅ 仅用 roleNames 字段展示
        const roleTags = this._parseRoleTags(w.roleNames);
        const roleLineText = roleTags.length ? roleTags.join('、') : '未设置';

        // ✅ 新增：两行展示裁剪 + 是否更多
        const { _roleTagsShow, _roleTagsMore } = this._buildRoleShow(roleTags);

        return {
          _id: w._id,
          thumbUrl,
          locationName: w.locationName || '',
          message: w.message || '',
          statusText,
          roleTags,
          roleLineText,
          _roleTagsShow,
          _roleTagsMore,
          createdAtText: this.formatTime(created)
        };
      });

      this.setData({ works });
    } catch (e) {
      console.error('[works] 加载失败：', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
      this.setData({ works: [] });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  /** 跳转查看 */
  openPhoto(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) {
      wx.showToast({ title: '缺少作品ID', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/photo/photo?photoId=${id}` });
  },

  /** 删除作品 */
  async deleteWork(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    wx.showModal({
      title: '确认删除',
      content: '删除后无法恢复，是否继续？',
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中...', mask: true });

        wx.cloud.callFunction({
          name: 'deletePhoto',
          data: { photoId: id }
        }).then(cfRes => {
          const ret = cfRes?.result || {};
          if (!ret.ok) {
            wx.showToast({
              title: ret.msg || '删除失败',
              icon: 'none'
            });
            return;
          }

          const list = this.data.works.filter(x => x._id !== id);
          this.setData({ works: list });
          wx.showToast({ title: '已删除', icon: 'success' });
        }).catch(err => {
          console.error('[works] deletePhoto error:', err);
          wx.showToast({ title: '删除失败', icon: 'none' });
        }).finally(() => {
          wx.hideLoading();
        });
      }
    });
  },

  /** 时间格式化 */
  formatTime(input) {
    if (!input) return '';
    let d;
    if (input instanceof Date) d = input;
    else if (typeof input === 'number') d = new Date(input > 1e12 ? input : input * 1000);
    else if (typeof input === 'string') {
      d = new Date(input);
      if (isNaN(d.getTime())) d = new Date(input.replace(/-/g, '/'));
    }
    if (!d || isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${mm}`;
  },

  /** 返回 */
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/my/my' });
  }
});
