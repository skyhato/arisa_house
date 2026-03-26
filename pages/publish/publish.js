// pages/publish/publish.js

const COLLECTION_CONFIG = 'app_config';
const COLLECTION_ACTIVITIES = 'activities';
const COLLECTION_USERS = 'users';

const HOME_PHOTOS_CACHE_KEY = 'home_photos_cache_v1';

// ====== 每日发布次数（按 guess 的 used/bonus 模型）======
const PUBLISH_STATE_KEY = 'publish_daily_state_v2';
const DAILY_FREE_TIMES = 3;

// 激励视频广告
const AD_UNIT_ID = 'adunit-c5d30cc09aa0404c';
let videoAd = null;
let hasBindVideoEvents = false;

// 原图压缩目标：800KB
const ORIGIN_TARGET_SIZE = 800 * 1024;
const ORIGIN_MAX_LONG_SIDE = 4096;

Page({
  data: {
    imagePreview: '',
    thumbTempPath: '',
    roundThumbTempPath: '',
    locationName: '',
    latitude: null,
    longitude: null,
    message: '',

    roleList: [],
    showRolePanel: false,
    closingRolePanel: false,
    selectedRoleIds: [],
    selectedRoleNames: [],
    checkedRoleIdSet: {},

    activityList: [],
    showActivityPanel: false,
    closingActivityPanel: false,
    selectedActivityId: '',
    selectedActivityName: '',

    user: {},
    publishing: false,
    commentEnabled: false,

    // ====== 次数展示 ======
    dailyUsed: 0,
    dailyLimit: DAILY_FREE_TIMES,
    dailyBonus: 0,
    remainingToday: 0,
    hasUnlimitedToday: false,
    canWatchAd: true,

    _todayStr: ''
  },

  // ✅ 支持从活动详情页带参：activityId/activityName
  async onLoad(options = {}) {
    await this.checkLogin();

    // ---- 处理带参（避免乱码/undefined/[object Object]）----
    const safeStr = (v) => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      try { return String(v); } catch (_) { return ''; }
    };
    const safeDecode = (s) => {
      const str = safeStr(s);
      if (!str) return '';
      try { return decodeURIComponent(str); } catch (_) { return str; }
    };

    const incomingActivityId = safeStr(options.activityId || options.id || '').trim();
    const incomingActivityName = safeDecode(options.activityName || options.name || '').trim();

    if (incomingActivityId) {
      // 先只写入 id +（如果有的话）name；name 缺失时后面 loadActivities 会补齐
      this.setData({
        selectedActivityId: incomingActivityId,
        selectedActivityName: incomingActivityName || ''
      });
    } else {
      // 没带参，确保是干净空字符串，避免 UI 显示 undefined
      this.setData({
        selectedActivityId: '',
        selectedActivityName: ''
      });
    }

    const today = this._getTodayStr();
    this.data._todayStr = today;
    this._loadTodayPublishState(today);

    this._initRewardAd();

    await this.loadGlobalConfig();
    await this.loadRoles();
    await this.loadActivities(); // ✅ 会兜底补全活动名（若只带了 id）
  },

  /* ================= 广告：初始化 & 奖励 ================= */

  _initRewardAd() {
    if (!wx.createRewardedVideoAd) {
      this.setData({ canWatchAd: false });
      return;
    }

    if (!videoAd) {
      videoAd = wx.createRewardedVideoAd({ adUnitId: AD_UNIT_ID });
    }

    if (!hasBindVideoEvents && videoAd) {
      videoAd.onLoad(() => {});
      videoAd.onError((err) => {
        console.error('[publish] videoAd error', err);
        this.setData({ canWatchAd: false });
        wx.showToast({ title: '广告加载失败', icon: 'none' });
      });

      videoAd.onClose((res) => {
        const ended = res && (res.isEnded === undefined || res.isEnded);
        if (ended) {
          this._onAdRewardOnce();
        } else {
          wx.showToast({ title: '完整看完才有奖励喔', icon: 'none' });
        }
      });

      hasBindVideoEvents = true;
    }
  },

  onWatchAdForPublish() {
    if (!videoAd) {
      wx.showToast({ title: '广告不可用', icon: 'none' });
      return;
    }
    videoAd.show().catch(() => {
      videoAd.load()
        .then(() => videoAd.show())
        .catch(err => {
          console.error('[publish] show ad fail', err);
          wx.showToast({ title: '广告暂时不可用', icon: 'none' });
        });
    });
  },

  _onAdRewardOnce() {
    // bonus +1
    this._state.bonus = (this._state.bonus || 0) + 1;
    this._saveTodayPublishState();
    wx.showToast({ title: '已奖励 1 次机会', icon: 'success' });
  },

  _promptAdIfNoChance() {
    if (this.data.hasUnlimitedToday) return;
    if (this.data.remainingToday > 0) return;
    if (!videoAd) {
      wx.showToast({ title: '今日次数已用完', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '次数用完啦',
      content: '观看一段视频广告可获得 1 次发布机会，要看吗？',
      confirmText: '看广告',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) this.onWatchAdForPublish();
      }
    });
  },

  /* ================= 每日次数：加载/保存/计算 ================= */

  _getTodayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${y}-${pad(m)}-${pad(day)}`;
  },

  _loadTodayPublishState(today) {
    // 兼容旧 key：你之前的 publish_daily_limit_v1（count/unlimited）
    const oldKey = 'publish_daily_limit_v1';

    let all = wx.getStorageSync(PUBLISH_STATE_KEY);
    if (!all || typeof all !== 'object') all = {};

    let state = all[today];
    if (!state) {
      // 尝试从旧结构迁移
      const oldAll = wx.getStorageSync(oldKey);
      if (oldAll && typeof oldAll === 'object') {
        const userKey = this._getUserKey();
        const rec = userKey ? oldAll[userKey] : null;
        if (rec && rec.date === today) {
          state = {
            used: rec.count || 0,
            bonus: 0,
            unlimited: !!rec.unlimited
          };
        }
      }
    }

    if (!state) {
      state = { used: 0, bonus: 0, unlimited: false };
    }

    this._state = state;
    this._savedAll = all;

    this._applyRemainingToView();
  },

  _saveTodayPublishState() {
    const today = this.data._todayStr || this._getTodayStr();
    const all = this._savedAll || {};
    all[today] = this._state;
    wx.setStorageSync(PUBLISH_STATE_KEY, all);
    this._applyRemainingToView();
  },

  _applyRemainingToView() {
    const s = this._state || { used: 0, bonus: 0, unlimited: false };
    const unlimited = !!s.unlimited;

    const used = s.used || 0;
    const bonus = s.bonus || 0;

    const remaining = unlimited ? 999999 : Math.max(0, DAILY_FREE_TIMES + bonus - used);

    this.setData({
      dailyUsed: used,
      dailyBonus: bonus,
      dailyLimit: DAILY_FREE_TIMES,
      hasUnlimitedToday: unlimited,
      remainingToday: unlimited ? 999999 : remaining,
      canWatchAd: true
    });
  },

  _useOneChanceAfterPublish() {
    if (this._state.unlimited) return;
    this._state.used = (this._state.used || 0) + 1;
    this._saveTodayPublishState();
  },

  _canPublishNow() {
    if (this.data.hasUnlimitedToday) return true;
    return this.data.remainingToday > 0;
  },

  _getUserKey() {
    const u = this.data.user || {};
    return u.userId || u._id || u.openid || u.openId || '';
  },

  /* ================= 全局配置 ================= */

  async loadGlobalConfig() {
    const db = wx.cloud.database();
    try {
      const res = await db.collection(COLLECTION_CONFIG).limit(1).get();
      const cfg = (res.data && res.data[0]) || null;
      let enabled = false;
      if (cfg && typeof cfg.commentEnabled === 'boolean') enabled = cfg.commentEnabled;
      this.setData({ commentEnabled: enabled });
    } catch (e) {
      console.warn('loadGlobalConfig fail:', e);
      this.setData({ commentEnabled: false });
    }
  },

  /* ================= 工具: 文件大小、压缩、裁剪 ================= */

  _fs() { return wx.getFileSystemManager(); },

  async _statSize(path) {
    return new Promise((resolve, reject) => {
      this._fs().stat({
        path,
        success: res => resolve(res.stats.size || 0),
        fail: reject
      });
    });
  },

  async _cloudIdToUrl(fileID) {
    if (!fileID || typeof fileID !== 'string') return '';
    if (!fileID.startsWith('cloud://')) return fileID;
    try {
      const { fileList } = await wx.cloud.getTempFileURL({ fileList: [fileID] });
      const f = fileList && fileList[0];
      return (f && f.tempFileURL) ? f.tempFileURL : '';
    } catch (e) {
      console.warn('getTempFileURL fail:', e);
      return '';
    }
  },

  async _compressToUnder800KB(srcPath, initialSizeBytes) {
    let size = initialSizeBytes || 0;
    if (!size) {
      try { size = await this._statSize(srcPath); } catch (_) { size = 0; }
    }
    if (size > 0 && size <= ORIGIN_TARGET_SIZE) return srcPath;

    const info = await wx.getImageInfo({ src: srcPath });
    let sw = info.width;
    let sh = info.height;

    const sys = wx.getSystemInfoSync();
    const dpr = Math.max(1, sys.pixelRatio || 1);

    const node = await new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this)
        .select('#thumbCanvas')
        .fields({ node: true, size: true })
        .exec(res => {
          if (res && res[0] && res[0].node) resolve(res[0].node);
          else reject(new Error('thumbCanvas not found for origin compress'));
        });
    });

    const canvas = node;
    const ctx = canvas.getContext('2d');

    const img = canvas.createImage();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = srcPath;
    });

    let bestPath = srcPath;
    let bestSize = size || Number.MAX_SAFE_INTEGER;

    let scaleFactor = 1.0;
    const origLong = Math.max(sw, sh);
    if (origLong > ORIGIN_MAX_LONG_SIDE) {
      scaleFactor = ORIGIN_MAX_LONG_SIDE / origLong;
    }

    let attempt = 0;
    const MAX_ATTEMPT = 10;

    while (attempt < MAX_ATTEMPT) {
      attempt++;

      const tw = Math.max(200, Math.round(sw * scaleFactor));
      const th = Math.max(200, Math.round(sh * scaleFactor));

      canvas.width = tw * dpr;
      canvas.height = th * dpr;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.drawImage(img, 0, 0, sw, sh, 0, 0, tw * dpr, th * dpr);

      const qualities = attempt === 1 ? [0.9, 0.8, 0.7, 0.6] : [0.7, 0.6, 0.5, 0.4, 0.35, 0.3];

      for (const q of qualities) {
        const out = await new Promise((resolve, reject) => {
          wx.canvasToTempFilePath({
            canvas,
            width: tw,
            height: th,
            destWidth: tw * dpr,
            destHeight: th * dpr,
            fileType: 'jpg',
            quality: q,
            success: resolve,
            fail: reject
          }, this);
        });

        const outPath = out.tempFilePath;
        const outSize = await this._statSize(outPath);

        if (outSize > 0 && outSize < bestSize) {
          bestSize = outSize;
          bestPath = outPath;
        }
        if (outSize > 0 && outSize <= ORIGIN_TARGET_SIZE) return outPath;
      }

      scaleFactor *= 0.75;
      if (Math.max(sw, sh) * scaleFactor < 600) break;
    }

    return bestPath;
  },

  async _cropCenterTo200(srcPath) {
    const info = await wx.getImageInfo({ src: srcPath });
    const sw = info.width, sh = info.height;
    const side = Math.min(sw, sh);
    const sx = Math.floor((sw - side) / 2);
    const sy = Math.floor((sh - side) / 2);

    const sys = wx.getSystemInfoSync();
    const dpr = Math.max(1, sys.pixelRatio || 1);

    const node = await new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this)
        .select('#thumbCanvas')
        .fields({ node: true, size: true })
        .exec(res => {
          if (res && res[0] && res[0].node) resolve(res[0].node);
          else reject(new Error('thumbCanvas not found'));
        });
    });

    const canvas = node;
    const ctx = canvas.getContext('2d');

    const DW = 200, DH = 200;
    canvas.width = DW * dpr;
    canvas.height = DH * dpr;

    const img = canvas.createImage();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = srcPath;
    });

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, DW * dpr, DH * dpr);

    const out = await new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas,
        width: DW,
        height: DH,
        destWidth: DW * dpr,
        destHeight: DH * dpr,
        fileType: 'jpg',
        quality: 0.92,
        success: resolve,
        fail: reject
      }, this);
    });

    return out.tempFilePath;
  },

  /* ================= 圆角 + 阴影缩略图 ================= */

  _markerCanvasOnce: null,

  async _getMarkerCanvas() {
    if (!this._markerCanvasOnce) {
      this._markerCanvasOnce = new Promise((resolve, reject) => {
        wx.createSelectorQuery().in(this)
          .select('#markerCanvas')
          .fields({ node: true, size: true })
          .exec(res => {
            if (!res || !res[0] || !res[0].node) return reject(new Error('markerCanvas not found'));
            const canvas = res[0].node;
            const ctx = canvas.getContext('2d');
            resolve({ canvas, ctx });
          });
      });
    }
    return this._markerCanvasOnce;
  },

  _roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  },

  async _makeRoundedShadowIcon(src, size, radius) {
    if (!src) return '';

    const { canvas, ctx } = await this._getMarkerCanvas();

    const scale = 2;
    const drawSize = size * scale;
    const pad = Math.round(size * 0.25) * scale;
    canvas.width = drawSize + pad * 2;
    canvas.height = drawSize + pad * 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const img = canvas.createImage();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = src;
    });

    const x = pad, y = pad, w = drawSize, h = drawSize;
    const r = Math.round((radius || size * 0.18) * scale);

    ctx.save();
    this._roundRectPath(ctx, x, y, w, h, r);
    ctx.clip();
    const iw = img.width, ih = img.height;
    const s = Math.min(iw, ih);
    const sx = (iw - s) / 2, sy = (ih - s) / 2;
    ctx.drawImage(img, sx, sy, s, s, x, y, w, h);
    ctx.restore();

    const tempPath = await new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas,
        x: 0, y: 0,
        width: canvas.width,
        height: canvas.height,
        destWidth: canvas.width,
        destHeight: canvas.height,
        fileType: 'png',
        success: res => resolve(res.tempFilePath),
        fail: reject
      });
    });

    return tempPath;
  },

  /* ================= 登录 & 最新头像 ================= */

  async _readLatestUserFromDB(openid) {
    if (!openid) return null;
    const db = wx.cloud.database();
    try {
      const res = await db.collection(COLLECTION_USERS).where({ openid: String(openid) }).limit(1).get();
      return (res.data && res.data[0]) ? res.data[0] : null;
    } catch (e) {
      console.warn('[publish] read users fail:', e);
      return null;
    }
  },

  async checkLogin() {
    let user = wx.getStorageSync('user');
    if (!user) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }

    const openid = user.openid || user.openId || user._openid || '';
    const udb = await this._readLatestUserFromDB(openid);

    const nickname =
      (udb && (udb.nickname || udb.nickName || udb.username)) ||
      (user.nickname || user.nickName || user.username) ||
      '匿名用户';

    let avatarFileID =
      (udb && (udb.avatarUrl || udb.avatar || udb.avatarFileID || udb.avatarFileId)) ||
      user.avatarFileID ||
      '';

    if (!avatarFileID && typeof user.avatar === 'string' && user.avatar.startsWith('cloud://')) {
      avatarFileID = user.avatar;
    }
    if (typeof avatarFileID !== 'string') avatarFileID = '';

    let avatarUrl =
      (udb && typeof udb.avatarUrl === 'string' && /^https?:\/\//i.test(udb.avatarUrl)) ? udb.avatarUrl :
      (typeof user.avatarUrl === 'string' && /^https?:\/\//i.test(user.avatarUrl)) ? user.avatarUrl :
      (typeof user.avatarUrlResolved === 'string' && /^https?:\/\//i.test(user.avatarUrlResolved)) ? user.avatarUrlResolved :
      (typeof user.avatar === 'string' && /^https?:\/\//i.test(user.avatar)) ? user.avatar :
      '';

    if (!avatarUrl && avatarFileID && avatarFileID.startsWith('cloud://')) {
      avatarUrl = await this._cloudIdToUrl(avatarFileID);
    }

    user = {
      ...user,
      nickname,
      openid,
      avatarFileID,
      avatarUrlResolved: avatarUrl || '',
      avatarUrl: avatarUrl || user.avatarUrl || ''
    };

    wx.setStorageSync('user', user);
    this.setData({ user });
  },

  /* ================= 拉取角色/活动 ================= */

  async loadRoles() {
    const db = wx.cloud.database();
    const _  = db.command;
    const coll = db.collection('roles');

    try {
      const { total = 0 } = await coll.where({ enabled: _.neq(false) }).count();
      const PAGE = 20;
      const all = [];

      for (let skip = 0; skip < total; skip += PAGE) {
        const res = await coll.where({ enabled: _.neq(false) })
          .orderBy('order', 'asc')
          .skip(skip)
          .limit(PAGE)
          .get();
        (res.data || []).forEach(d => all.push(d));
      }

      const roles = (all || [])
        .map(r => {
          const id = String(r._id || r.id);
          const ord = (typeof r.order === 'number') ? r.order
            : Number(r.order) === Number(r.order) ? Number(r.order)
            : Number.POSITIVE_INFINITY;
          return { ...r, _id: id, id, name: (r.name || r.roleName || '未命名角色') + '', order: ord };
        })
        .sort((a, b) => (a.order - b.order) || (a.name || '').localeCompare(b.name || ''));

      this.setData({ roleList: roles });

      if ((this.data.selectedRoleIds || []).length) {
        const set = new Set(this.data.selectedRoleIds.map(String));
        const names = roles.filter(r => set.has(String(r.id))).map(r => r.name);
        const checked = {};
        roles.forEach(r => { if (set.has(String(r.id))) checked[String(r.id)] = true; });
        this.setData({ selectedRoleNames: names, checkedRoleIdSet: checked });
      }
    } catch (e) {
      console.warn('loadRoles fail', e);
      wx.showToast({ title: '获取角色失败', icon: 'none' });
      this.setData({ roleList: [] });
    }
  },

  async loadActivities() {
    const db = wx.cloud.database();
    const _  = db.command;
    const coll = db.collection(COLLECTION_ACTIVITIES);
  
    // ✅ 只显示“正在进行中”的活动
    const now = new Date();
  
    try {
      const whereCond = {
        enabled: _.neq(false),
        startTime: _.lte(now),
        endTime: _.gte(now),
      };
  
      const { total = 0 } = await coll.where(whereCond).count();
      const PAGE = 20;
      const all = [];
  
      for (let skip = 0; skip < total; skip += PAGE) {
        const res = await coll.where(whereCond)
          .orderBy('order', 'asc')
          .skip(skip)
          .limit(PAGE)
          .get();
        (res.data || []).forEach(d => all.push(d));
      }
  
      const activities = (all || [])
        .map(a => {
          const id = String(a._id || a.id);
          const ord = (typeof a.order === 'number') ? a.order
            : Number(a.order) === Number(a.order) ? Number(a.order)
            : Number.POSITIVE_INFINITY;
          const name = (a.name || a.activityName || a.title || '未命名活动');
          return { ...a, _id: id, id, name: String(name), order: ord };
        })
        .sort((a, b) => (a.order - b.order) || (a.name || '').localeCompare(b.name || ''));
  
      this.setData({ activityList: activities });
  
      // ✅ 兜底：如果当前已选的活动不在“进行中列表”里（比如活动已结束/未开始），就清空，避免还能选中提交
      const curId = String(this.data.selectedActivityId || '').trim();
      if (curId) {
        const hit = activities.find(a => String(a.id || a._id) === curId);
        if (!hit) {
          this.setData({ selectedActivityId: '', selectedActivityName: '' });
        } else {
          // 只在 name 为空/异常时补齐
          const curName = String(this.data.selectedActivityName || '').trim();
          const looksBad =
            !curName ||
            curName === 'undefined' ||
            curName === 'null' ||
            curName === '[object Object]';
          if (looksBad) this.setData({ selectedActivityName: String(hit.name || '') });
        }
      } else {
        this.setData({ selectedActivityName: '' });
      }
    } catch (e) {
      console.warn('loadActivities fail', e);
      this.setData({ activityList: [] });
    }
  },
  

  /* ================= 选择图片/位置/留言 ================= */

  // ✅ 有活动时：点击上传先弹窗提醒
  onChooseImage() {
    const { selectedActivityId } = this.data;
    const selectedActivityName = String(this.data.selectedActivityName || '').trim();

    const doChoose = () => {
      wx.chooseImage({
        count: 1,
        success: async (res) => {
          try {
            const tempPath =
              (res.tempFilePaths && res.tempFilePaths[0]) ||
              (res.tempFiles && res.tempFiles[0]?.tempFilePath);

            let sizeBytes = 0;
            if (res.tempFiles && res.tempFiles[0] && typeof res.tempFiles[0].size === 'number') {
              sizeBytes = res.tempFiles[0].size;
            } else {
              try { sizeBytes = await this._statSize(tempPath); } catch (_) {}
            }

            const originCompressedPath = await this._compressToUnder800KB(tempPath, sizeBytes);
            const thumb200 = await this._cropCenterTo200(originCompressedPath);

            let roundThumbPath = '';
            try {
              const baseSize = 80;
              roundThumbPath = await this._makeRoundedShadowIcon(thumb200, baseSize, Math.round(baseSize * 0.18));
            } catch (e) {
              roundThumbPath = thumb200;
            }

            this.setData({
              imagePreview: originCompressedPath,
              thumbTempPath: thumb200,
              roundThumbTempPath: roundThumbPath
            });
          } catch (e) {
            console.error('选择/处理图片失败：', e);
            wx.showToast({ title: e.message || '图片处理失败', icon: 'none' });
          }
        }
      });
    };

    if (selectedActivityId) {
      const name = selectedActivityName || '该';
      wx.showModal({
        title: '活动提醒',
        content: `您选择了${name}活动，请注意活动要求，不符合的照片将无法通过审核。`,
        confirmText: '继续上传',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) doChoose();
        }
      });
      return;
    }

    doChoose();
  },

  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          locationName: res.name || res.address || '',
          latitude: res.latitude,
          longitude: res.longitude
        });
      },
      fail: (err) => {
        const msg = String(err?.errMsg || '');
        if (!/cancel/i.test(msg)) wx.showToast({ title: '选择位置失败', icon: 'none' });
      }
    });
  },

  onMessageInput(e) { this.setData({ message: e.detail.value }); },

  /* ================= 角色面板（多选） ================= */

  __animMs() { return 220; },

  openRolePanel() {
    const ids = (this.data.selectedRoleIds || []).map(String);
    const checked = {};
    ids.forEach(id => { checked[id] = true; });
    this.setData({ showRolePanel: true, closingRolePanel: false, checkedRoleIdSet: checked });
  },

  closeRolePanel() {
    if (!this.data.showRolePanel && !this.data.closingRolePanel) return;
    this.setData({ closingRolePanel: true });
    setTimeout(() => {
      this.setData({ showRolePanel: false, closingRolePanel: false });
    }, this.__animMs());
  },

  onRoleCheckChange(e) {
    const roleList = this.data.roleList || [];
    const rawIds = Array.isArray(e.detail?.value) ? e.detail.value : [];
    const ids = rawIds.map(String);

    const set = new Set(ids);
    const checkedMap = {};
    const names = [];

    roleList.forEach(r => {
      const id = String(r.id || r._id);
      if (set.has(id)) {
        checkedMap[id] = true;
        names.push(r.name);
      }
    });

    this.setData({
      selectedRoleIds: ids,
      selectedRoleNames: names,
      checkedRoleIdSet: checkedMap
    });
  },

  confirmRoleSelection() { this.closeRolePanel(); },

  /* ================= 活动面板（单选） ================= */

  openActivityPanel() {
    this.setData({ showActivityPanel: true, closingActivityPanel: false });
  },

  closeActivityPanel() {
    if (!this.data.showActivityPanel && !this.data.closingActivityPanel) return;
    this.setData({ closingActivityPanel: true });
    setTimeout(() => {
      this.setData({ showActivityPanel: false, closingActivityPanel: false });
    }, this.__animMs());
  },

  onActivityChange(e) {
    const list = this.data.activityList || [];
    const id = e.detail?.value ? String(e.detail.value) : '';
    const found = id ? list.find(a => String(a.id || a._id) === id) : null;

    this.setData({
      selectedActivityId: id,
      selectedActivityName: found ? String(found.name || found.activityName || found.title || '') : ''
    });
  },

  clearActivitySelection() {
    this.setData({ selectedActivityId: '', selectedActivityName: '' });
  },

  confirmActivitySelection() { this.closeActivityPanel(); },

  /* ================= 发布 ================= */

  async onPublish() {
    if (this.data.publishing) return;

    if (!this._canPublishNow()) {
      wx.showToast({ title: '今日次数已用完', icon: 'none' });
      this._promptAdIfNoChance();
      return;
    }

    const {
      imagePreview, thumbTempPath, roundThumbTempPath,
      locationName, latitude, longitude,
      message, selectedRoleIds, user,
      commentEnabled
    } = this.data;

    const selectedActivityId = String(this.data.selectedActivityId || '').trim();
    const selectedActivityName = String(this.data.selectedActivityName || '').trim();

    if (!imagePreview) return wx.showToast({ title: '请先选择图片', icon: 'none' });

    if (commentEnabled) {
      if (!selectedRoleIds.length) return wx.showToast({ title: '请选择角色', icon: 'none' });
      if (!locationName) return wx.showToast({ title: '请先选择位置', icon: 'none' });
    }

    this.setData({ publishing: true });
    wx.showLoading({ title: '上传中...' });

    try {
      const originRes = await wx.cloud.uploadFile({
        cloudPath: `origin/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
        filePath: imagePreview
      });

      const thumbRes = await wx.cloud.uploadFile({
        cloudPath: `thumb/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
        filePath: thumbTempPath
      });

      const roundPath = roundThumbTempPath || thumbTempPath;
      const roundRes = await wx.cloud.uploadFile({
        cloudPath: `roundThumb/${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
        filePath: roundPath
      });

      const originFileID     = originRes.fileID;
      const thumbFileID      = thumbRes.fileID;
      const roundThumbFileID = roundRes.fileID;

      let originUrl = '', thumbUrl = '', roundThumbUrl = '';
      try {
        const { fileList } = await wx.cloud.getTempFileURL({
          fileList: [originFileID, thumbFileID, roundThumbFileID]
        });
        (fileList || []).forEach(f => {
          if (f.fileID === originFileID) originUrl = f.tempFileURL || '';
          if (f.fileID === thumbFileID) thumbUrl = f.tempFileURL || '';
          if (f.fileID === roundThumbFileID) roundThumbUrl = f.tempFileURL || '';
        });
      } catch (e) {}

      const nickname = user.nickname || user.nickName || '匿名用户';
      const avatarUrl = user.avatarUrlResolved || user.avatarUrl || '';

      const callRes = await wx.cloud.callFunction({
        name: 'createPublish',
        data: {
          originFileID,
          thumbFileID,
          roundThumbFileID,
          originUrl,
          thumbUrl,
          roundThumbUrl,
          roleIds: selectedRoleIds,
          message,
          locationName,
          latitude,
          longitude,
          nickname,
          avatarUrl,
          userId: user.userId || user._id || '',
          // ✅ 活动字段写入 publish，给活动详情页过滤用
          activityId: selectedActivityId || '',
          activityName: selectedActivityName || ''
        }
      });

      wx.hideLoading();

      const r = callRes.result || {};
      if (r.ok) {
        this._useOneChanceAfterPublish();
        wx.removeStorageSync(HOME_PHOTOS_CACHE_KEY);

        wx.showToast({ title: '发布成功', icon: 'success', duration: 2500 });
        setTimeout(() => wx.navigateTo({ url: '/pages/works/works' }), 2500);
      } else {
        wx.showToast({ title: r.msg || '发布失败', icon: 'none' });
      }
    } catch (e) {
      console.error('发布过程异常：', e);
      wx.hideLoading();
      wx.showToast({ title: '上传失败', icon: 'none' });
    } finally {
      this.setData({ publishing: false });
    }
  },

  goBack() { wx.navigateBack({ delta: 1 }); },
  noop() {}
});
