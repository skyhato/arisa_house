// pages/userAdmin/userAdmin.js
// 用户管理页：分页调用云函数 adminListUsers
// 支持：搜索、按注册时间/作品数排序、分页“加载更多”、删除用户及其作品
// 兼容 cloud:// 头像（批量转临时链接），并在顶部展示总用户数 total

const PAGE_SIZE = 100;           // 建议与云函数一致（<=100）
const PUBLISH_COLL = 'publish';
const USERS_COLL = 'users';

Page({
  data: {
    loading: false,
    loadingMore: false,

    // 排序与搜索
    sortMode: 'time',            // 'time' | 'works'
    searchKey: '',

    // 分页
    page: 0,
    pageSize: PAGE_SIZE,
    items: [],                   // 渲染用数组（WXML 请使用 items）
    hasMore: true,

    // 顶部统计
    total: 0                     // ✅ 云函数返回的总用户数
  },

  onLoad() {
    this.checkAdminAndLoad();
  },

  /* ========== 管理员校验后加载 ========== */
  async checkAdminAndLoad() {
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'checkAdmin' });
      const ret = res.result || {};
      if (!ret.isAdmin) {
        wx.showToast({ title: '无权访问', icon: 'none' });
        setTimeout(() => {
          const pages = getCurrentPages();
          if (pages.length > 1) wx.navigateBack();
          else wx.switchTab({ url: '/pages/index/index' });
        }, 800);
        return;
      }
      this.reloadFirstPage();
    } catch (err) {
      console.error('[userAdmin] checkAdmin error:', err);
      wx.showToast({ title: '校验失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /* ========== 搜索 & 排序 ========== */
  onSearchInput(e) {
    this.setData({ searchKey: e.detail.value || '' });
  },

  onSearchConfirm() {
    this.reloadFirstPage();
  },

  onChangeSort(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.sortMode) return;
    this.setData({ sortMode: mode }, () => this.reloadFirstPage());
  },

  /* ========== 重新加载第一页 ========== */
  async reloadFirstPage() {
    this.setData({ page: 0, items: [], hasMore: true });
    await this.loadPage(0);
  },

  /* ========== 加载某一页（从 0 开始） ========== */
  async loadPage(page) {
    if (!this.data.hasMore && page !== 0) return;

    const { sortMode, searchKey, pageSize } = this.data;
    this.setData(page === 0 ? { loading: true } : { loadingMore: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'adminListUsers',
        data: { page, pageSize, sortMode, searchKey }
      });

      const ret = res.result || {};
      if (!ret.ok) {
        wx.showToast({ title: ret.msg || '拉取失败', icon: 'none' });
        this.setData({ loading: false, loadingMore: false });
        return;
      }

      // 1) 合并新增数据
      const list = ret.items || [];
      let merged = page === 0 ? list : this.data.items.concat(list);

      // 2) 批量把 cloud:// 头像转临时链接（仅处理新增加的那段）
      const startIdx = page === 0 ? 0 : (merged.length - list.length);
      const endIdx = merged.length;
      merged = await this._resolveAvatarTempURLs(merged, startIdx, endIdx);

      // 3) 计算 hasMore（优先使用后端返回）
      const hasMore = typeof ret.hasMore === 'boolean' ? ret.hasMore : (list.length === pageSize);

      // 4) 保存数据 + 总用户数 total
      this.setData({
        items: merged,
        page,
        hasMore,
        total: typeof ret.total === 'number' ? ret.total : (this.data.total || 0)  // ✅ 顶部统计
      });
    } catch (e) {
      console.error('[userAdmin] loadPage error:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  /**
   * 批量把 cloud:// 的头像转为临时链接，写入 item.avatarResolved
   * 仅处理 [start, end) 区间，避免重复转换
   */
  async _resolveAvatarTempURLs(arr, start = 0, end = arr.length) {
    try {
      const list = arr.slice(); // 浅拷贝
      const needConvert = [];

      for (let i = start; i < end; i++) {
        const it = list[i] || {};
        const src = it.avatar || it.avatarUrl || it.avatarURL || '';
        if (typeof src === 'string' && src.startsWith && src.startsWith('cloud://')) {
          needConvert.push({ idx: i, fileID: src });
        } else {
          list[i] = { ...it, avatarResolved: src || '' };
        }
      }

      // 分批（50个一批） getTempFileURL
      const BATCH = 50;
      for (let k = 0; k < needConvert.length; k += BATCH) {
        const sub = needConvert.slice(k, k + BATCH);
        const fileList = sub.map(x => x.fileID);
        try {
          const ret = await wx.cloud.getTempFileURL({ fileList });
          const rlist = ret.fileList || [];
          sub.forEach((x, idx) => {
            const temp = rlist[idx] && rlist[idx].tempFileURL ? rlist[idx].tempFileURL : '';
            const i = x.idx;
            list[i] = { ...list[i], avatarResolved: temp || list[i].avatar || '' };
          });
        } catch (err) {
          console.warn('[userAdmin] getTempFileURL batch error:', err);
          sub.forEach(x => {
            const i = x.idx;
            list[i] = { ...list[i], avatarResolved: list[i].avatar || '' };
          });
        }
      }

      return list;
    } catch (e) {
      console.error('[userAdmin] _resolveAvatarTempURLs error:', e);
      // 兜底：直接透传
      return arr.map(x => ({ ...x, avatarResolved: x.avatar || '' }));
    }
  },

  /* ========== 加载更多（下一页） ========== */
  onLoadMore() {
    if (!this.data.hasMore) return;
    const next = this.data.page + 1;
    this.loadPage(next);
  },

  /* ========== 删除用户及其所有作品 ========== */
  onDeleteUser(e) {
    const openid = e.currentTarget.dataset.openid;
    if (!openid) return;

    wx.showModal({
      title: '确认操作',
      content: '确定要删除该用户及其所有作品吗？此操作不可恢复！',
      confirmColor: '#ff4d4f',
      success: (r) => {
        if (r.confirm) this._deleteUserAndPhotos(openid);
      }
    });
  },

  async _deleteUserAndPhotos(openid) {
    this.setData({ loading: true });
    const db = wx.cloud.database();

    try {
      // 1) 分批拉取该用户所有作品并逐个调用 deletePhoto
      const BATCH = 50;
      let skip = 0;
      for (;;) {
        const res = await db.collection(PUBLISH_COLL)
          .where({ openid: String(openid) })
          .skip(skip)
          .limit(BATCH)
          .get();
        const list = res.data || [];
        for (const p of list) {
          try {
            await wx.cloud.callFunction({
              name: 'deletePhoto',
              data: { photoId: String(p._id) }
            });
          } catch (err) {
            console.error('[userAdmin] deletePhoto failed:', p._id, err);
          }
        }
        if (list.length < BATCH) break;
        skip += BATCH;
      }

      // 2) 删除用户文档（兼容 docId / where）
      try {
        await db.collection(USERS_COLL).doc(String(openid)).remove();
      } catch (_) {
        const found = await db.collection(USERS_COLL).where({ openid: String(openid) }).limit(1).get();
        if (found.data && found.data[0]) {
          await db.collection(USERS_COLL).doc(found.data[0]._id).remove();
        }
      }

      wx.showToast({ title: '已删除该用户', icon: 'success' });

      // 3) 本地移除，并保持 hasMore 状态不变
      const items = (this.data.items || []).filter(u => u.openid !== openid);
      this.setData({ items });
    } catch (e) {
      console.error('[userAdmin] deleteUser error:', e);
      wx.showToast({ title: '删除失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /* ========== 底部返回 ========== */
  onBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/profile/profile' });
  }
});
