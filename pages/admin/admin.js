// pages/admin/admin.js
// 审核页：PENDING / APPROVED 列表 + 审核通过 / 退回 / 删除
// 只展示：上传者、地点、活动、角色(roleNames)、上传时间

const COLLECTION_PUBLISH = 'publish';

/** ===== 性能相关常量 ===== */
const TEMP_URL_CACHE_TTL = 25 * 60 * 1000; // 25分钟
const TEMP_URL_BATCH_SIZE = 50;            // 分批换临时链接
const APPROVE_CONCURRENCY = 4;             // 一键审核并发

Page({
  data: {
    works: [],
    defaultThumb: '/assets/default-avatar.png',
    loading: false,

    // 分页
    pageSize: 20,
    page: 0,
    total: 0,
    hasMore: true,

    // 一键审核相关
    hasPending: false,
    batchLoading: false,

    // 登录 & 权限状态
    isAdmin: false
  },

  onLoad() {
    // fileID -> { url, expireAt }
    this._tempUrlCache = new Map();
    // 降级方案B用：PENDING 总数缓存（reset 时清掉）
    this._pendingCountCache = null;

    this.checkAdminAndLoad();
  },

  async onShow() {
    if (this.data.isAdmin) {
      this.loadWorks(true, false);
    }
  },

  /** 先检查是否登录，再调用 checkAdmin 云函数判定权限 */
  async checkAdminAndLoad() {
    const user = wx.getStorageSync('user');
    if (!user || !(user.openid || user.openId)) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }

    wx.showLoading({ title: '校验权限...', mask: true });
    try {
      const r = await wx.cloud.callFunction({ name: 'checkAdmin' });
      const ret = r.result || {};

      if (!ret.ok) {
        wx.showToast({ title: ret.msg || '校验失败', icon: 'none' });
        wx.switchTab({ url: '/pages/my/my' });
        return;
      }
      if (!ret.isAdmin) {
        wx.showToast({ title: '无权限访问', icon: 'none' });
        wx.switchTab({ url: '/pages/my/my' });
        return;
      }

      this.setData({ isAdmin: true });
      this.loadWorks(true, true);
    } catch (e) {
      console.error('[admin] checkAdmin fail:', e);
      wx.showToast({ title: '校验失败', icon: 'none' });
      wx.switchTab({ url: '/pages/my/my' });
    } finally {
      wx.hideLoading();
    }
  },

  /** ===== 临时链接：缓存 + 去重 + 分批 ===== */
  async _toTempUrls(fileIds) {
    const now = Date.now();
    const ids = (fileIds || [])
      .filter(id => typeof id === 'string' && id.startsWith('cloud://'));

    if (!ids.length) return {};

    const out = {};
    const needFetch = [];
    const seen = new Set();

    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);

      const cached = this._tempUrlCache?.get(id);
      if (cached && cached.url && cached.expireAt > now) {
        out[id] = cached.url;
      } else {
        needFetch.push(id);
      }
    }

    if (!needFetch.length) return out;

    const chunks = [];
    for (let i = 0; i < needFetch.length; i += TEMP_URL_BATCH_SIZE) {
      chunks.push(needFetch.slice(i, i + TEMP_URL_BATCH_SIZE));
    }

    try {
      const results = await Promise.all(
        chunks.map(list =>
          wx.cloud.getTempFileURL({ fileList: list })
            .then(r => r.fileList || [])
            .catch(() => [])
        )
      );

      const flat = results.flat();
      flat.forEach(f => {
        const fid = f.fileID;
        const url = f.tempFileURL || '';
        if (!fid) return;
        if (url) {
          out[fid] = url;
          this._tempUrlCache?.set(fid, { url, expireAt: now + TEMP_URL_CACHE_TTL });
        }
      });

      return out;
    } catch (e) {
      console.warn('[admin] getTempFileURL fail:', e);
      return out;
    }
  },

  _fmtTime(ts) {
    if (!ts) return '';
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const pad = n => (n < 10 ? ('0' + n) : '' + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  async _countWorks() {
    const db = wx.cloud.database();
    const _ = db.command;
    const r = await db.collection(COLLECTION_PUBLISH)
      .where({ status: _.in(['PENDING', 'APPROVED']) })
      .count();
    return r.total || 0;
  },

  /**
   * 分页读取：优先 PENDING，再 APPROVED
   * 优先尝试多重排序（status desc, createdAt desc），若不支持则降级为“双查询合并”
   */
  async _fetchWorksPage(skip, limit) {
    const db = wx.cloud.database();
    const _ = db.command;

    // 只取审核页需要的字段：上传者/地点/活动/角色(roleNames)/时间/缩略图/状态
    const fields = {
      thumbUrl: true,
      thumbFileID: true,
      originFileID: true,

      nickname: true,
      locationName: true,

      activityId: true,
      activityName: true,

      roleNames: true,     // 只保留 roleNames
      status: true,

      createdAt: true,
      createTime: true,
      dayStr: true
    };

    // —— 方案A：尝试 status desc + createdAt desc（PENDING 会排在前面）
    try {
      const res = await db.collection(COLLECTION_PUBLISH)
        .where({ status: _.in(['PENDING', 'APPROVED']) })
        .field(fields)
        .orderBy('status', 'desc')
        .orderBy('createdAt', 'desc')
        .skip(skip)
        .limit(limit)
        .get();

      return res.data || [];
    } catch (e) {
      console.warn('[admin] multi-orderBy unsupported, fallback merge:', e);
    }

    // —— 方案B：降级为“双查询合并”，正确处理 skip/limit
    let pendingCount = 0;
    if (typeof this._pendingCountCache === 'number') {
      pendingCount = this._pendingCountCache;
    } else {
      try {
        const c = await db.collection(COLLECTION_PUBLISH)
          .where({ status: 'PENDING' })
          .count();
        pendingCount = c.total || 0;
        this._pendingCountCache = pendingCount;
      } catch (e) {
        console.warn('[admin] count PENDING fail:', e);
        pendingCount = 0;
        this._pendingCountCache = 0;
      }
    }

    const pendingSkip  = Math.min(skip, pendingCount);
    const pendingTake  = Math.max(Math.min(limit, pendingCount - pendingSkip), 0);
    const approvedSkip = Math.max(skip - pendingCount, 0);
    const approvedTake = Math.max(limit - pendingTake, 0);

    const tasks = [];

    if (pendingTake > 0) {
      tasks.push(
        db.collection(COLLECTION_PUBLISH)
          .where({ status: 'PENDING' })
          .field(fields)
          .orderBy('createdAt', 'desc')
          .skip(pendingSkip)
          .limit(pendingTake)
          .get()
          .then(r => r.data || [])
          .catch(() => [])
      );
    } else tasks.push(Promise.resolve([]));

    if (approvedTake > 0) {
      tasks.push(
        db.collection(COLLECTION_PUBLISH)
          .where({ status: 'APPROVED' })
          .field(fields)
          .orderBy('createdAt', 'desc')
          .skip(approvedSkip)
          .limit(approvedTake)
          .get()
          .then(r => r.data || [])
          .catch(() => [])
      );
    } else tasks.push(Promise.resolve([]));

    const [pendings, approveds] = await Promise.all(tasks);
    return [].concat(pendings, approveds);
  },

  async _normalizeWorksList(rawList) {
    if (!rawList || rawList.length === 0) return [];

    // 去重收集 fileID，减少 getTempFileURL 压力
    const fileIdSet = new Set();
    rawList.forEach(w => {
      if (!w.thumbUrl) {
        const fid =
          (typeof w.thumbFileID === 'string' && w.thumbFileID.startsWith('cloud://') && w.thumbFileID) ||
          (typeof w.originFileID === 'string' && w.originFileID.startsWith('cloud://') && w.originFileID) ||
          '';
        if (fid) fileIdSet.add(fid);
      }
    });

    const fileIds = Array.from(fileIdSet);
    const id2url = fileIds.length ? await this._toTempUrls(fileIds) : {};

    const works = rawList.map(w => {
      let thumbUrl = w.thumbUrl || '';
      if (!thumbUrl) {
        const fid =
          (typeof w.thumbFileID === 'string' && w.thumbFileID) ||
          (typeof w.originFileID === 'string' && w.originFileID) ||
          '';
        if (fid && fid.startsWith('cloud://')) {
          thumbUrl = id2url[fid] || '';
        }
      }

      // 角色：只显示 roleNames
      const roleNamesArr = Array.isArray(w.roleNames) ? w.roleNames : (w.roleNames ? [w.roleNames] : []);
      const roleNamesText = roleNamesArr.filter(Boolean).map(String).join('、');

      // 活动：直接用 publish 存的 activityName
      const activityName = (w.activityName || '').trim();

      // 时间：优先 createdAt/createTime（更精确），兜底 dayStr
      const rawTs = w.createdAt || w.createTime || null;
      const createdAtText = rawTs ? this._fmtTime(rawTs) : (w.dayStr || '');

      return {
        _id: String(w._id || w.id || ''),
        id: String(w._id || w.id || ''),
        status: w.status || 'PENDING',

        thumbUrl: thumbUrl || this.data.defaultThumb,

        nickname: w.nickname || '匿名用户',
        locationName: w.locationName || '未知',

        activityName: activityName || '（无）',
        roleNamesText: roleNamesText || '（无）',

        createdAtText
      };
    });

    return works;
  },

  async loadWorks(reset = false, withLoading = true) {
    if (this.data.loading) return;

    if (withLoading) wx.showLoading({ title: '加载中...', mask: true });
    this.setData({ loading: true });

    try {
      let { page, pageSize, total, hasMore } = this.data;

      if (reset) {
        page = 0;
        total = 0;
        hasMore = true;
        this._pendingCountCache = null;
        this.setData({ works: [], page, total, hasMore });
      }

      if (!hasMore && !reset) return;

      if (total === 0) {
        total = await this._countWorks();
        this.setData({ total });
        if (!total) {
          this.setData({ works: [], hasMore: false, hasPending: false });
          return;
        }
      }

      const skip = page * pageSize;
      if (skip >= total) {
        this.setData({ hasMore: false });
        return;
      }

      const raw = await this._fetchWorksPage(skip, pageSize);
      const normalized = await this._normalizeWorksList(raw);
      const merged = reset ? normalized : this.data.works.concat(normalized);

      const nextPage = page + 1;
      const stillHasMore = merged.length < total;
      const hasPending = merged.some(w => w.status === 'PENDING');

      this.setData({
        works: merged,
        page: nextPage,
        hasMore: stillHasMore,
        hasPending
      });
    } catch (e) {
      console.error('[admin] loadWorks error:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
      if (reset) this.setData({ works: [], hasMore: false, hasPending: false });
    } finally {
      if (withLoading) wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  onLoadMore() {
    this.loadWorks(false, true);
  },

  /* ===== 审核操作工具函数 ===== */

  _approveOne(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const r = await wx.cloud.callFunction({
          name: 'approveWork',
          data: { photoId: id }
        });
        const ret = r?.result || {};
        if (!ret.ok) throw new Error(ret.msg || '云函数失败');
        resolve(true);
      } catch (cfErr) {
        console.warn('[admin] approveWork CF failed, fallback DB:', cfErr);
        try {
          const db = wx.cloud.database();
          await db.collection(COLLECTION_PUBLISH).doc(String(id)).update({
            data: { status: 'APPROVED' }
          });
          resolve(true);
        } catch (dbErr) {
          reject(dbErr);
        }
      }
    });
  },

  approveWork(e) {
    const id = e?.currentTarget?.dataset?.id;
    if (!id) return wx.showToast({ title: '缺少作品ID', icon: 'none' });

    wx.showModal({
      title: '确认审核',
      content: '确定将该作品标记为已通过？',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '提交中...', mask: true });
        try {
          await this._approveOne(id);
          wx.showToast({ title: '审核通过', icon: 'success' });
        } catch (err) {
          wx.showToast({ title: '审核失败', icon: 'none' });
        } finally {
          wx.hideLoading();
          this.loadWorks(true, false);
        }
      }
    });
  },

  async _approveAllByCloudBatch(ids) {
    const chunkSize = 100;
    let ok = 0;

    for (let i = 0; i < ids.length; i += chunkSize) {
      const part = ids.slice(i, i + chunkSize);
      const r = await wx.cloud.callFunction({
        name: 'approveWorksBatch',
        data: { photoIds: part }
      });
      const ret = r?.result || {};
      if (!ret.ok) throw new Error(ret.msg || 'approveWorksBatch failed');
      ok += (ret.updated || part.length);
    }
    return ok;
  },

  approveAllPending() {
    const pending = (this.data.works || []).filter(w => w.status === 'PENDING');
    if (!pending.length) {
      return wx.showToast({ title: '没有待审核作品', icon: 'none' });
    }

    wx.showModal({
      title: '一键审核确认',
      content: `将当前列表中全部 ${pending.length} 条待审核作品标记为已通过，是否继续？`,
      success: async (res) => {
        if (!res.confirm) return;

        this.setData({ batchLoading: true });
        wx.showLoading({ title: '批量审核中...', mask: true });

        const ids = pending.map(x => x._id).filter(Boolean);
        const total = ids.length;

        let successCount = 0;
        let failCount = 0;

        const runPool = async (items, worker, concurrency) => {
          let idx = 0;
          const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
            while (idx < items.length) {
              const cur = items[idx++];
              await worker(cur);
            }
          });
          await Promise.all(runners);
        };

        try {
          try {
            const updated = await this._approveAllByCloudBatch(ids);
            successCount = updated;
            failCount = Math.max(total - successCount, 0);
          } catch (batchErr) {
            console.warn('[admin] approveWorksBatch not available or failed, fallback pool:', batchErr);

            let done = 0;
            await runPool(ids, async (id) => {
              try {
                await this._approveOne(id);
                successCount++;
              } catch (e) {
                failCount++;
              } finally {
                done++;
                wx.showLoading({ title: `审核中 ${done}/${total}`, mask: true });
              }
            }, APPROVE_CONCURRENCY);
          }

          wx.showToast({
            title: failCount === 0
              ? `已通过 ${successCount} 条`
              : `成功 ${successCount} 条，失败 ${failCount} 条`,
            icon: failCount === 0 ? 'success' : 'none'
          });
        } finally {
          wx.hideLoading();
          this.setData({ batchLoading: false });
          this.loadWorks(true, false);
        }
      }
    });
  },

  returnWork(e) {
    const id = e?.currentTarget?.dataset?.id;
    if (!id) return wx.showToast({ title: '缺少作品ID', icon: 'none' });

    wx.showModal({
      title: '确认退回',
      content: '确定将该作品退回为待审核状态？',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '提交中...', mask: true });
        try {
          const r = await wx.cloud.callFunction({
            name: 'returnWork',
            data: { photoId: id }
          });
          const ret = r?.result || {};
          if (!ret.ok) throw new Error(ret.msg || '云函数失败');

          wx.showToast({ title: '已退回', icon: 'success' });
        } catch (cfErr) {
          console.warn('[admin] returnWork CF failed, fallback DB:', cfErr);
          try {
            const db = wx.cloud.database();
            await db.collection(COLLECTION_PUBLISH).doc(String(id)).update({
              data: { status: 'PENDING' }
            });
            wx.showToast({ title: '已退回', icon: 'success' });
          } catch (dbErr) {
            wx.showToast({ title: '退回失败', icon: 'none' });
          }
        } finally {
          wx.hideLoading();
          this.loadWorks(true, false);
        }
      }
    });
  },

  deleteWork(e) {
    const id = e?.currentTarget?.dataset?.id;
    if (!id) return wx.showToast({ title: '缺少作品ID', icon: 'none' });

    wx.showModal({
      title: '确认删除',
      content: '删除后无法恢复，将同时清理所有关联图片文件，是否继续？',
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
            wx.showToast({ title: ret.msg || '删除失败', icon: 'none' });
          } else {
            wx.showToast({ title: '已删除', icon: 'success' });
          }
        }).catch(err => {
          console.error('[admin] deletePhoto CF error:', err);
          wx.showToast({ title: '删除失败', icon: 'none' });
        }).finally(() => {
          wx.hideLoading();
          this.loadWorks(true, false);
        });
      }
    });
  },

  onPullDownRefresh() {
    Promise.resolve()
      .then(() => this.loadWorks(true, false))
      .catch(() => {})
      .finally(() => {
        wx.stopPullDownRefresh();
      });
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/my/my' });
  }
});
