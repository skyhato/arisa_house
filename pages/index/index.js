// pages/index/index.js
const COLLECTION_PUBLISH = 'publish';
const COLLECTION_ROLES = 'roles';
const COLLECTION_CONFIG = 'app_config';
const COLLECTION_AD_POOL = 'launch_ads';

const MIN_SIZE = 50;
const MAX_SIZE = 90;
const DEFAULT_MARKER_ICON = '/assets/default-avatar.png';

// ✅ 小程序端云开发数据库：单次 get 最大返回 20
const DB_PAGE_LIMIT = 20;

// ====== 地图展示控制 ======
const MAX_VIEW_MARKERS = 100;       // 地图上最多渲染 100 个点（大区域）
const DENSE_REGION_GRID_DEG = 0.5;  // 稠密区域网格大小（用于裁剪多余点）

// 地图区域更新节流
const REGION_DEBOUNCE_MS = 150;
const REGION_MOVE_THRESHOLD_RATIO = 0.15;

// 全局采样用的自适应网格参数（细格子）
const GLOBAL_GRID_START_ROWS = 12;   // 全局采样初始行数
const GLOBAL_GRID_START_COLS = 24;   // 全局采样初始列数
const GLOBAL_GRID_MIN_ROWS   = 4;    // 自适应缩小时不要比这个再粗
const GLOBAL_GRID_MIN_COLS   = 8;    // 自适应缩小时不要比这个再粗

// 「大区」网格（保证每个大区至少一张）
const BIG_GRID_ROWS = 4;
const BIG_GRID_COLS = 4;

// 本地缓存
const HOME_PHOTOS_CACHE_KEY = 'home_photos_cache_v1';
const ROLES_CACHE_KEY       = 'roles_cache_v1';
const PHOTOS_CACHE_TTL      = 60 * 1000;
const ROLES_CACHE_TTL       = 24 * 60 * 60 * 1000;

// 拉取数量控制
const INITIAL_FETCH_LIMIT = 150;    // 兜底：最新 150 条
const REGION_FETCH_LIMIT  = 200;    // 普通区域模式最多拉 200 条（候选），再压到 100 个 marker

// 缩放阈值
const SCALE_REGION_FETCH  = 9;      // >= 9 省级/城市级 → 区域模式
const SCALE_REGION_PANEL  = 12;     // >= 12 才允许“查看当前区域照片”，视为最小区域
const SCALE_GLOBAL_SAMPLE = 6;      // <= 6 全局模式

// ===== 模式切换滞回（避免抖动误切） =====
const HYSTERESIS = {
  toRegion: SCALE_REGION_FETCH,
  backFromRegion: SCALE_REGION_FETCH - 0.6,
  toGlobal: SCALE_GLOBAL_SAMPLE,
  backFromGlobal: SCALE_GLOBAL_SAMPLE + 0.6
};

// ===== 地图模式切换提示开关 =====
const MAP_MODE_TIP_ENABLED = false;

// —— 手动刷新：当前视图重排参数 ——（保持你原本配置）
const REFRESH_PAGE_LIMIT = 100;  // 单次分页上限
const REFRESH_MAX_ROUNDS = 5;    // 最多拉 5 页（500）
const REFRESH_CACHE_MIN  = 24;   // 缓存命中但数量太少则打库补齐

Page({
  data: {

    // ===== 广告相关 =====
    showAd: false,
    adImageUrl: 'cloud://cloud1-5gpzszjh5b3c4a84.636c-cloud1-5gpzszjh5b3c4a84-1385178608/images/arisa1.png',
    adShowMode: 'daily',
    adEnabled: true,
    adImageList: [],
    adCurrentIndex: 0,

    // ===== 地图 & 照片相关 =====
    latitude: 35.86166,
    longitude: 104.195397,
    scale: 4,
    markers: [],
    markerMap: {},
    roleList: [],
    checkedRoleIdSet: {},
    showFilterPanel: false,

    // ✅ 顶部第二行“加载中.../展示前xx张”
    isLoadingMarkers: false,

    _allPhotos: [],
    _likesMin: 0,
    _likesMax: 0,

    visibleCount: 0,          // 顶部“当前区域有 XX 张照片”
    showRegionPanel: false,
    regionPhotos: [],

    _lastRegionBox: null
  },

  async onLoad() {
    this._scale = this.data.scale || 4;
    this._visibleCountReqId = 0;
    this._currentMode = 'global';      // 'global' | 'region' | 'mid'
    this._lastRegionFetchBox = null;   // 上次从服务器拉区域数据的 box
    this._lastGlobalBox = null;        // 上次全局视角下记录的 box

    // 用于“滑动结束后”判定（不进 data，不影响渲染）
    this._fromRegionChange = false;

    // 轻量去重：避免短时间重复对同一 box 打库（仅用于全局拉取）
    this._lastGlobalFetchKey = '';
    this._lastGlobalFetchTs = 0;

    await this.loadAdConfig();
    this.loadRoles();
    this.loadApprovedPhotos();
  },

  onShow() {
    this.loadApprovedPhotos();
  },

  onReady() {
    this.mapCtx = wx.createMapContext('map');
    setTimeout(() => this._updateCountFromCurrentRegion(), 200);
  },

  // ========= 广告逻辑（保持原实现） =========
  async loadAdConfig() {
    const db = wx.cloud.database();
    try {
      const resCfg = await db.collection(COLLECTION_CONFIG)
        .where({ key: 'launchAd' })
        .limit(1)
        .get();

      let cfg = resCfg.data && resCfg.data[0] ? resCfg.data[0] : {};
      const imgFromCfg = cfg.imageUrl || cfg.adImageUrl || this.data.adImageUrl;

      const rawMode = (cfg.showMode || '').toString().trim().toLowerCase();
      const mode = rawMode === 'daily' ? 'daily' : 'always';

      const enabled = cfg.enabled !== false;

      const resAds = await db.collection(COLLECTION_AD_POOL)
        .where({ enabled: true })
        .orderBy('_id', 'asc')
        .get();

      const poolList = (resAds.data || [])
        .map(d => d.imageUrl || d.adImageUrl)
        .filter(u => typeof u === 'string' && u.length > 0);

      let finalImageList = poolList;
      let finalImageUrl = imgFromCfg || this.data.adImageUrl;
      let finalIndex = 0;

      if (finalImageList.length > 0) {
        finalImageUrl = finalImageList[0];
      } else {
        finalImageList = [finalImageUrl];
      }

      if (mode === 'always') {
        wx.removeStorageSync('hasSeenLaunchAdDate');
      }

      this.setData({
        adImageUrl: finalImageUrl,
        adShowMode: mode,
        adEnabled: enabled,
        adImageList: finalImageList,
        adCurrentIndex: finalIndex
      }, () => {
        this.applyLaunchAdStrategy();
      });
    } catch (e) {
      console.warn('[loadAdConfig] failed:', e);
      this.setData({
        adEnabled: false,
        showAd: false,
        adImageList: [],
        adCurrentIndex: 0
      });
    }
  },

  applyLaunchAdStrategy() {
    const { adEnabled, adShowMode, adImageList } = this.data;

    if (!adEnabled || !Array.isArray(adImageList) || adImageList.length === 0) {
      this.setData({ showAd: false });
      return;
    }

    if (adShowMode === 'always') {
      this.setData({
        showAd: true,
        adCurrentIndex: 0,
        adImageUrl: adImageList[0]
      });
      return;
    }

    const key = 'hasSeenLaunchAdDate';
    const today = new Date().toISOString().slice(0, 10);
    const seenDate = wx.getStorageSync(key);

    if (seenDate !== today) {
      this.setData({
        showAd: true,
        adCurrentIndex: 0,
        adImageUrl: adImageList[0]
      });
      wx.setStorageSync(key, today);
    } else {
      this.setData({ showAd: false });
    }
  },

  onAdClose() {
    const { adImageList, adCurrentIndex } = this.data;

    if (Array.isArray(adImageList) && adImageList.length > 0) {
      const nextIndex = adCurrentIndex + 1;
      if (nextIndex < adImageList.length) {
        this.setData({
          adCurrentIndex: nextIndex,
          adImageUrl: adImageList[nextIndex],
          showAd: true
        });
        return;
      }
    }
    this.setData({ showAd: false });
  },

  noop() {},

  // ========= 地图区域变化 =========
  _regionDebounce: null,
  onRegionChange(e) {
    if (!e || !e.type) return;

    const detail = e.detail || {};
    if (Number.isFinite(Number(detail.scale))) {
      this._scale = Number(detail.scale);
    }

    if (e.type !== 'end') return;
    if (!this.data._allPhotos || this.data._allPhotos.length === 0) {
      clearTimeout(this._regionDebounce);
      this._regionDebounce = setTimeout(() => {
        this._updateCountFromCurrentRegion(0, true);
      }, REGION_DEBOUNCE_MS);
      return;
    }

    clearTimeout(this._regionDebounce);
    this._regionDebounce = setTimeout(() => {
      this._updateCountFromCurrentRegion(0, true);
    }, REGION_DEBOUNCE_MS);
  },

  // ========= 小工具 =========
  _isFiniteNum(v) { return Number.isFinite(Number(v)); },

  _isValidBox(box) {
    if (!box) return false;
    const { minLat, maxLat, minLng, maxLng } = box;
    return [minLat, maxLat, minLng, maxLng].every(this._isFiniteNum)
      && maxLat > minLat && maxLng > minLng
      && maxLat <= 90 && minLat >= -90
      && maxLng <= 180 && minLng >= -180;
  },

  _normalizeBox(box) {
    if (!this._isValidBox(box)) return null;
    const fixed = { ...box };
    const wrap = (x)=> {
      while (x >= 180) x -= 360;
      while (x < -180) x += 360;
      return x;
    };
    fixed.minLng = wrap(fixed.minLng);
    fixed.maxLng = wrap(fixed.maxLng);
    if (fixed.minLng > fixed.maxLng) {
      const t = fixed.minLng; fixed.minLng = fixed.maxLng; fixed.maxLng = t;
    }
    return fixed;
  },

  _getRoleFiltered() {
    const { _allPhotos, checkedRoleIdSet } = this.data;
    const active = Object.keys(checkedRoleIdSet || {}).filter(id => checkedRoleIdSet[id]);
    if (active.length === 0) return _allPhotos || [];
    return (_allPhotos || []).filter(p =>
      Array.isArray(p.roleIds) && p.roleIds.some(rid => checkedRoleIdSet[String(rid)])
    );
  },

  _filterByBox(list, box) {
    const { minLat, maxLat, minLng, maxLng } = box;
    const out = [];
    for (const p of list) {
      const la = Number(p.latitude), ln = Number(p.longitude);
      if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
      if (la >= minLat && la <= maxLat && ln >= minLng && ln <= maxLng) out.push(p);
    }
    return out;
  },

  // 判断两个 box 是否是“小范围移动”
  _isSmallMoveBox(oldBox, newBox) {
    if (!this._isValidBox(oldBox) || !this._isValidBox(newBox)) return false;

    const oldCenterLat = (oldBox.minLat + oldBox.maxLat) / 2;
    const oldCenterLng = (oldBox.minLng + oldBox.maxLng) / 2;
    const newCenterLat = (newBox.minLat + newBox.maxLat) / 2;
    const newCenterLng = (newBox.minLng + newBox.maxLng) / 2;

    const latSpan = oldBox.maxLat - oldBox.minLat || 1;
    const lngSpan = oldBox.maxLng - oldBox.minLng || 1;
    const latShift = Math.abs(newCenterLat - oldCenterLat);
    const lngShift = Math.abs(newCenterLng - oldCenterLng);

    const latThresh = latSpan * REGION_MOVE_THRESHOLD_RATIO;
    const lngThresh = lngSpan * REGION_MOVE_THRESHOLD_RATIO;

    return latShift < latThresh && lngShift < lngThresh;
  },

  // ===== 新增：把已勾选的角色 id 映射为 name 列表，用于服务器端 roleNames 过滤 =====
  _getActiveRoleNames() {
    const { checkedRoleIdSet, roleList } = this.data;
    const activeIds = Object.keys(checkedRoleIdSet || {}).filter(id => checkedRoleIdSet[id]);
    if (activeIds.length === 0) return [];
    const id2name = new Map(
      (roleList || []).map(r => [String(r.id || r._id), r.name || r.roleName || ''])
    );
    const names = activeIds.map(id => id2name.get(String(id))).filter(Boolean);
    return names;
  },

  // ===== 新增：辅助把 roleNames 条件追加到 conds 中（仅当筛选生效时）=====
  _appendRoleNameCond(conds, _) {
    const activeRoleNames = this._getActiveRoleNames();
    if (activeRoleNames.length > 0) {
      conds.push({ roleNames: _.in(activeRoleNames) });
    }
  },

  // 顶部“当前区域有 XX 张照片”（大区域用 count，小区域 full fetch 自己设）
  async _updateVisibleCountAccurate(box) {
    if (!this._isValidBox(box)) return;

    const db = wx.cloud.database();
    const _ = db.command;

    const conds = [
      { status: 'APPROVED' },
      { latitude: _.gte(box.minLat).and(_.lte(box.maxLat)) },
      { longitude: _.gte(box.minLng).and(_.lte(box.maxLng)) }
    ];
    this._appendRoleNameCond(conds, _);

    const reqId = ++this._visibleCountReqId;

    try {
      const res = await db.collection(COLLECTION_PUBLISH)
        .where(_.and(conds))
        .count();
      if (reqId !== this._visibleCountReqId) return;

      const total = res.total || 0;
      this.setData({ visibleCount: total });
    } catch (e) {
      console.warn('[visibleCountAccurate] failed:', e);
    }
  },

  // ====== 模式决策（带滞回） ======
  _decideModeWithHysteresis(prevMode, scale) {
    if (!Number.isFinite(scale)) return prevMode || 'global';

    if (prevMode === 'region') {
      if (scale < HYSTERESIS.backFromRegion) {
        if (scale <= HYSTERESIS.toGlobal) return 'global';
        return 'mid';
      }
      return 'region';
    }

    if (prevMode === 'global') {
      if (scale > HYSTERESIS.backFromGlobal) {
        if (scale >= HYSTERESIS.toRegion) return 'region';
        return 'mid';
      }
      return 'global';
    }

    if (scale >= HYSTERESIS.toRegion) return 'region';
    if (scale <= HYSTERESIS.toGlobal) return 'global';
    return 'mid';
  },

  // ========= 模式切换：global / region / mid =========
  _updateCountFromCurrentRegion(retry = 0, fromRegionChange = false) {
    if (!this.mapCtx) this.mapCtx = wx.createMapContext('map');

    // ✅ 记录本次是否来自“滑动结束”
    this._fromRegionChange = !!fromRegionChange;

    this.mapCtx.getRegion({
      success: (res) => {
        const { southwest, northeast } = res || {};
        let box = null;
        if (southwest && northeast) {
          box = {
            minLat: Math.min(southwest.latitude, northeast.latitude),
            maxLat: Math.max(southwest.latitude, northeast.latitude),
            minLng: Math.min(southwest.longitude, northeast.longitude),
            maxLng: Math.max(southwest.longitude, northeast.longitude)
          };
        }

        let hasBox = this._isValidBox(box);
        if (hasBox) {
          box = this._normalizeBox(box);
          hasBox = this._isValidBox(box);
          if (hasBox) this.setData({ _lastRegionBox: box });
        }

        const scale = Number.isFinite(this._scale) ? this._scale : (this.data.scale || 4);
        const prevMode = this._currentMode || 'global';
        let mode = this._decideModeWithHysteresis(prevMode, scale);

        if (MAP_MODE_TIP_ENABLED && mode !== prevMode) {
          let msg = '';
          if (mode === 'global') msg = '已切换到全国模式';
          else if (mode === 'region') msg = '已切换到区域模式';
          else msg = '已切换到中间模式';
          wx.showToast({ title: msg, icon: 'none', duration: 1000 });
        }

        if (hasBox) {
          const isMinRegion = (mode === 'region' && scale >= SCALE_REGION_PANEL);
          if (!isMinRegion) this._updateVisibleCountAccurate(box);
        }

        // ===== global 模式
        if (mode === 'global') {
          this._currentMode = 'global';

          const hasBoxNow = this._isValidBox(box);
          const lastGlobalBox = this._lastGlobalBox;
          let needReloadByMove = false;

          if (hasBoxNow && lastGlobalBox) {
            const old = lastGlobalBox;
            const latSpan = old.maxLat - old.minLat || 1;
            const lngSpan = old.maxLng - old.minLng || 1;
            const oldCenterLat = (old.minLat + old.maxLat) / 2;
            const oldCenterLng = (old.minLng + old.maxLng) / 2;
            const newCenterLat = (box.minLat + box.maxLat) / 2;
            const newCenterLng = (box.minLng + box.maxLng) / 2;
            const latShift = Math.abs(newCenterLat - oldCenterLat);
            const lngShift = Math.abs(newCenterLng - oldCenterLng);
            needReloadByMove = (latShift > latSpan * 0.5) || (lngShift > lngSpan * 0.5);
          }
          if (hasBoxNow) this._lastGlobalBox = box;

          if (prevMode !== 'global' || needReloadByMove) {
            this.setData({ isLoadingMarkers: true });
            if (hasBoxNow) {
              this._loadGlobalBoxPhotos(box);
            } else {
              this._loadGlobalDistributedSample();
            }
            return;
          }

          const boxToUse = this._isValidBox(box) ? box : this.data._lastRegionBox;

          // ✅ 仅在“滑动结束后”的 global 模式：若当前视窗内可用照片 < 100，则按视窗重拉一次补齐到 100
          if (fromRegionChange && this._isValidBox(boxToUse)) {
            const cachedAll = this._getRoleFiltered();
            const inBox = this._filterByBox(cachedAll, boxToUse);
            if (!Array.isArray(inBox) || inBox.length === 0 || inBox.length < MAX_VIEW_MARKERS) {
              this.setData({ isLoadingMarkers: true });
              this._loadGlobalBoxPhotos(boxToUse);
              return;
            }
          }

          this.applyRoleFilterAndRender(this._isValidBox(boxToUse) ? boxToUse : null);
          return;
        }

        // ===== region 模式
        if (mode === 'region') {
          this._currentMode = 'region';
          const isMinRegion = scale >= SCALE_REGION_PANEL;

          // ✅ 只有要走打库/全量时才进“加载中...”
          this.setData({ isLoadingMarkers: true });

          if (isMinRegion) {
            this._loadRegionPhotosFull(box);
          } else {
            this._loadRegionPhotos(box);
          }
          return;
        }

        // ===== 中间缩放
        this._currentMode = 'mid';

        if (hasBox) {
          const cachedAll = this._getRoleFiltered();
          const inBox = this._filterByBox(cachedAll, box);

          if (!Array.isArray(inBox) || inBox.length === 0) {
            this.setData({ isLoadingMarkers: true });
            this._loadGlobalBoxPhotos(box);
            return;
          }

          const target = Math.min(MAX_VIEW_MARKERS, inBox.length);
          const evenly = this._distributeGlobalPhotosEvenly(inBox, target, box);

          let likesMin = 0, likesMax = 0;
          if (evenly.length > 0) {
            likesMin = evenly.reduce((m, p) => Math.min(m, p.likesCount), evenly[0].likesCount);
            likesMax = evenly.reduce((m, p) => Math.max(m, p.likesCount), evenly[0].likesCount);
          }

          if (evenly.length === 0) {
            this.setData({ isLoadingMarkers: true });
            this._loadGlobalBoxPhotos(box);
            return;
          }

          this.setData(
            { _allPhotos: evenly, _likesMin: likesMin, _likesMax: likesMax },
            () => this.applyRoleFilterAndRender(null)
          );
        } else if (this._isValidBox(this.data._lastRegionBox)) {
          const last = this.data._lastRegionBox;
          const cachedAll = this._getRoleFiltered();
          const inBox = this._filterByBox(cachedAll, last);

          if (!Array.isArray(inBox) || inBox.length === 0) {
            this.setData({ isLoadingMarkers: true });
            this._loadGlobalBoxPhotos(last);
            return;
          }

          const target = Math.min(MAX_VIEW_MARKERS, inBox.length);
          const evenly = this._distributeGlobalPhotosEvenly(inBox, target, last);

          let likesMin = 0, likesMax = 0;
          if (evenly.length > 0) {
            likesMin = evenly.reduce((m, p) => Math.min(m, p.likesCount), evenly[0].likesCount);
            likesMax = evenly.reduce((m, p) => Math.max(m, p.likesCount), evenly[0].likesCount);
          }

          if (evenly.length === 0) {
            this.setData({ isLoadingMarkers: true });
            this._loadGlobalBoxPhotos(last);
            return;
          }

          this.setData(
            { _allPhotos: evenly, _likesMin: likesMin, _likesMax: likesMax },
            () => this.applyRoleFilterAndRender(null)
          );
        } else {
          if (!this.data._allPhotos || this.data._allPhotos.length === 0) {
            this.setData({ isLoadingMarkers: true });
            this._loadGlobalDistributedSample();
            return;
          }
          this.applyRoleFilterAndRender(null);
        }
      },
      fail: () => {
        if (retry < 2) {
          setTimeout(() => this._updateCountFromCurrentRegion(retry + 1, fromRegionChange), 120);
          return;
        }
        const last = this.data._lastRegionBox;
        if (this._isValidBox(last)) {
          this._updateVisibleCountAccurate(last);
          this.applyRoleFilterAndRender(last);
        } else {
          this.setData({ isLoadingMarkers: true });
          this._loadGlobalDistributedSample();
        }
      }
    });
  },

  // ========= 区域模式（普通）
  async _loadRegionPhotos(box) {
    if (!this._isValidBox(box)) {
      const last = this.data._lastRegionBox;
      if (this._isValidBox(last)) {
        this.applyRoleFilterAndRender(last);
      } else {
        this.setData({ isLoadingMarkers: true });
        await this._loadGlobalDistributedSample();
      }
      return;
    }

    const cachedAll = this._getRoleFiltered();
    const cachedInBox = this._filterByBox(cachedAll, box);

    // ✅ 省级/城市（非最小区域）在滑动结束后：如果缓存里不足 100，不直接返回，走打库补齐
    const needAutoFill = !!this._fromRegionChange &&
      Array.isArray(cachedInBox) &&
      cachedInBox.length > 0 &&
      cachedInBox.length < MAX_VIEW_MARKERS;

    if (Array.isArray(cachedInBox) && cachedInBox.length > 0 && !needAutoFill) {
      this.applyRoleFilterAndRender(box);
      return;
    }

    this._lastRegionFetchBox = box;
    const db = wx.cloud.database();
    const _ = db.command;

    const conds = [
      { status: 'APPROVED' },
      { latitude: _.gte(box.minLat).and(_.lte(box.maxLat)) },
      { longitude: _.gte(box.minLng).and(_.lte(box.maxLng)) }
    ];
    this._appendRoleNameCond(conds, _);

    try {
      const photos = [];
      const idSet = new Set();
      let skip = 0;
      let hasMore = true;

      const MAX_PAGES = Math.ceil(REGION_FETCH_LIMIT / DB_PAGE_LIMIT);

      for (let i = 0; i < MAX_PAGES && hasMore; i++) {
        const res = await db.collection(COLLECTION_PUBLISH)
          .where(_.and(conds))
          .orderBy('_id', 'desc')
          .skip(skip)
          .limit(DB_PAGE_LIMIT)
          .get();

        const list = res.data || [];
        if (list.length < DB_PAGE_LIMIT) hasMore = false;
        skip += DB_PAGE_LIMIT;

        for (const p of list) {
          const mapped = this._mapDbRecordToPhoto(p);
          if (!mapped || idSet.has(mapped.id)) continue;
          idSet.add(mapped.id);
          photos.push(mapped);
        }

        if (this._fromRegionChange) {
          if (photos.length >= MAX_VIEW_MARKERS) break;
        } else {
          if (photos.length >= DB_PAGE_LIMIT) break;
        }
      }

      let finalList = photos;

      if (this._fromRegionChange && finalList.length < MAX_VIEW_MARKERS) {
        const more = await this._fetchAllApprovedFromPublish();
        const pool = [];
        const idSet2 = new Set(finalList.map(p => p.id));

        for (const p of more) {
          const m = this._mapDbRecordToPhoto(p);
          if (!m || idSet2.has(m.id)) continue;
          const la = m.latitude, ln = m.longitude;
          if (la < box.minLat || la > box.maxLat || ln < box.minLng || ln > box.maxLng) continue;
          idSet2.add(m.id);
          pool.push(m);
          if (pool.length >= (MAX_VIEW_MARKERS - finalList.length)) break;
        }
        finalList = finalList.concat(pool);
      }

      let likesMin = 0, likesMax = 0;
      if (finalList.length > 0) {
        likesMin = finalList.reduce((m, p) => Math.min(m, p.likesCount), finalList[0].likesCount);
        likesMax = finalList.reduce((m, p) => Math.max(m, p.likesCount), finalList[0].likesCount);
      }

      this.setData(
        { _allPhotos: finalList, _likesMin: likesMin, _likesMax: likesMax },
        () => this.applyRoleFilterAndRender(box)
      );
    } catch (e) {
      console.warn('[loadRegionPhotos] failed:', e);
      await this._loadGlobalBoxPhotos(box);
    }
  },

  // ========= 区域模式（最小区域）：全量
  async _loadRegionPhotosFull(box) {
    const fullReqId = ++this._visibleCountReqId;
    this._lastRegionFetchBox = box;

    const db = wx.cloud.database();
    const _ = db.command;

    const conds = [
      { status: 'APPROVED' },
      { latitude: _.gte(box.minLat).and(_.lte(box.maxLat)) },
      { longitude: _.gte(box.minLng).and(_.lte(box.maxLng)) }
    ];
    this._appendRoleNameCond(conds, _);

    try {
      const PAGE = DB_PAGE_LIMIT;
      let all = [];
      let skip = 0;
      let hasMore = true;

      while (hasMore) {
        const res = await db.collection(COLLECTION_PUBLISH)
          .where(_.and(conds))
          .orderBy('_id', 'desc')
          .skip(skip)
          .limit(PAGE)
          .get();

        const list = res.data || [];
        all = all.concat(list);
        if (list.length < PAGE) hasMore = false;
        else skip += PAGE;
      }

      if (fullReqId !== this._visibleCountReqId) return;

      const photos = [];
      const idSet = new Set();
      for (const p of all) {
        const mapped = this._mapDbRecordToPhoto(p);
        if (!mapped || idSet.has(mapped.id)) continue;
        idSet.add(mapped.id);
        photos.push(mapped);
      }

      let likesMin = 0, likesMax = 0;
      if (photos.length > 0) {
        likesMin = photos.reduce((m, p) => Math.min(m, p.likesCount), photos[0].likesCount);
        likesMax = photos.reduce((m, p) => Math.max(m, p.likesCount), photos[0].likesCount);
      }

      this.setData(
        { _allPhotos: photos, _likesMin: likesMin, _likesMax: likesMax, visibleCount: photos.length },
        () => this.applyRoleFilterAndRender(box)
      );
    } catch (e) {
      console.warn('[loadRegionPhotosFull] failed:', e);
      await this._loadGlobalBoxPhotos(box);
    }
  },

  // ========= 全局模式：按当前视窗范围拉取并均匀分布 =========
  async _loadGlobalBoxPhotos(box) {
    if (!this._isValidBox(box)) {
      await this._loadGlobalDistributedSample();
      return;
    }

    const activeRoleNames = this._getActiveRoleNames();
    const keyBox = `${box.minLat.toFixed(3)},${box.maxLat.toFixed(3)},${box.minLng.toFixed(3)},${box.maxLng.toFixed(3)}`;
    const keyRole = activeRoleNames.join('|');
    const fetchKey = `${keyBox}::${keyRole}`;
    const nowTs = Date.now();
    if (this._lastGlobalFetchKey === fetchKey && (nowTs - this._lastGlobalFetchTs) < 1200) {
      this.applyRoleFilterAndRender(null);
      return;
    }
    this._lastGlobalFetchKey = fetchKey;
    this._lastGlobalFetchTs = nowTs;

    const db = wx.cloud.database();
    const _ = db.command;

    const conds = [
      { status: 'APPROVED' },
      { latitude: _.gte(box.minLat).and(_.lte(box.maxLat)) },
      { longitude: _.gte(box.minLng).and(_.lte(box.maxLng)) }
    ];
    this._appendRoleNameCond(conds, _);

    const PAGE_LIMIT = DB_PAGE_LIMIT; // 20
    const MAX_ROUNDS = 5;             // 100

    try {
      const photos = [];
      const idSet = new Set();

      let evenly = [];
      for (let i = 0; i < MAX_ROUNDS; i++) {
        const res = await db.collection(COLLECTION_PUBLISH)
          .where(_.and(conds))
          .orderBy('_id', 'desc')
          .skip(i * PAGE_LIMIT)
          .limit(PAGE_LIMIT)
          .get();

        const raw = res.data || [];
        for (const p of raw) {
          const mapped = this._mapDbRecordToPhoto(p);
          if (!mapped || idSet.has(mapped.id)) continue;
          idSet.add(mapped.id);
          photos.push(mapped);
        }

        if (photos.length >= MAX_VIEW_MARKERS) {
          evenly = this._distributeGlobalPhotosEvenly(photos, MAX_VIEW_MARKERS, box);
          if (evenly.length >= MAX_VIEW_MARKERS) break;
        }

        if (raw.length < PAGE_LIMIT) break;
      }

      if (!evenly || evenly.length === 0) {
        const target0 = Math.min(MAX_VIEW_MARKERS, photos.length);
        evenly = this._distributeGlobalPhotosEvenly(photos, target0, box);
      }

      let likesMin = 0, likesMax = 0;
      if (evenly.length > 0) {
        likesMin = evenly.reduce((m, p) => Math.min(m, p.likesCount), evenly[0].likesCount);
        likesMax = evenly.reduce((m, p) => Math.max(m, p.likesCount), evenly[0].likesCount);
      }

      if (evenly.length === 0) {
        await this._loadGlobalDistributedSample();
        return;
      }

      this.setData(
        { _allPhotos: evenly, _likesMin: likesMin, _likesMax: likesMax },
        () => this.applyRoleFilterAndRender(null)
      );
    } catch (e) {
      console.warn('[loadGlobalBoxPhotos] failed, fallback to global sample:', e);
      await this._loadGlobalDistributedSample();
    }
  },

  // ========= 全局模式：均匀分布 100 张，保证每个“大区”都有 =========
  async _loadGlobalDistributedSample() {
    const db = wx.cloud.database();
    const _ = db.command;

    const PAGE_LIMIT = DB_PAGE_LIMIT; // 20
    const MAX_ROUNDS = 5;             // 100

    const conds = [{ status: 'APPROVED' }];
    this._appendRoleNameCond(conds, _);

    try {
      const photos = [];
      const idSet = new Set();
      let evenly = [];

      for (let i = 0; i < MAX_ROUNDS; i++) {
        const res = await db.collection(COLLECTION_PUBLISH)
          .where(_.and(conds))
          .orderBy('_id', 'desc')
          .skip(i * PAGE_LIMIT)
          .limit(PAGE_LIMIT)
          .get();

        const raw = res.data || [];
        for (const p of raw) {
          const mapped = this._mapDbRecordToPhoto(p);
          if (!mapped || idSet.has(mapped.id)) continue;
          idSet.add(mapped.id);
          photos.push(mapped);
        }

        if (photos.length >= MAX_VIEW_MARKERS) {
          evenly = this._distributeGlobalPhotosEvenly(photos, MAX_VIEW_MARKERS, null);
          if (evenly.length >= MAX_VIEW_MARKERS) break;
        }

        if (raw.length < PAGE_LIMIT) break;
      }

      if (!evenly || evenly.length === 0) {
        const target0 = Math.min(MAX_VIEW_MARKERS, photos.length);
        evenly = this._distributeGlobalPhotosEvenly(photos, target0, null);
      }

      let likesMin = 0, likesMax = 0;
      if (evenly.length > 0) {
        likesMin = evenly.reduce((m, p) => Math.min(m, p.likesCount), evenly[0].likesCount);
        likesMax = evenly.reduce((m, p) => Math.max(m, p.likesCount), evenly[0].likesCount);
      }

      this.setData(
        { _allPhotos: evenly, _likesMin: likesMin, _likesMax: likesMax },
        () => this.applyRoleFilterAndRender(null)
      );

      wx.setStorageSync(HOME_PHOTOS_CACHE_KEY, {
        time: Date.now(),
        photos: evenly,
        likesMin,
        likesMax
      });
    } catch (e) {
      console.warn('[loadGlobalDistributedSample] failed:', e);
      try {
        const raw = await this._fetchAllApprovedFromPublish();
        const photos = [];
        raw.forEach(p => {
          const mapped = this._mapDbRecordToPhoto(p);
          if (mapped) photos.push(mapped);
        });
        const target = Math.min(MAX_VIEW_MARKERS, photos.length);
        const evenly = this._distributeGlobalPhotosEvenly(photos, target, null);
        let likesMin = 0, likesMax = 0;
        if (evenly.length > 0) {
          likesMin = evenly.reduce((m, p) => Math.min(m, p.likesCount), evenly[0].likesCount);
          likesMax = evenly.reduce((m, p) => Math.max(m, p.likesCount), evenly[0].likesCount);
        }
        this.setData(
          { _allPhotos: evenly, _likesMin: likesMin, _likesMax: likesMax },
          () => this.applyRoleFilterAndRender(null)
        );
      } catch (e2) {
        console.warn('[fallback fetchAllApproved] failed:', e2);
      }
    }
  },

  // ====== 视窗对齐的均匀分布抽样（支持传入 viewBox） ======
  _distributeGlobalPhotosEvenly(photos, limit, viewBox = null) {
    if (!Array.isArray(photos) || photos.length === 0 || limit <= 0) return [];

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    const useLocal = viewBox && this._isValidBox(viewBox);
    const latMinG = useLocal ? viewBox.minLat : -90;
    const latMaxG = useLocal ? viewBox.maxLat : 90;
    const lngMinG = useLocal ? viewBox.minLng : -180;
    const lngMaxG = useLocal ? viewBox.maxLng : 180;
    const latSpanG = latMaxG - latMinG || 1;
    const lngSpanG = lngMaxG - lngMinG || 1;

    const toCellRC = (lat, lng, rows, cols) => {
      let r = Math.floor((lat - latMinG) / latSpanG * rows);
      let c = Math.floor((lng - lngMinG) / lngSpanG * cols);
      r = clamp(r, 0, rows - 1);
      c = clamp(c, 0, cols - 1);
      return [r, c];
    };

    const BIG_R = BIG_GRID_ROWS, BIG_C = BIG_GRID_COLS;
    const bigMap = new Map();
    const bigKeys = [];
    const keyOf = (r,c) => `${r},${c}`;

    for (const p of photos) {
      const lat = Number(p.latitude), lng = Number(p.longitude);
      if (!this._isValidLatLng(lat, lng)) continue;
      const [r, c] = toCellRC(lat, lng, BIG_R, BIG_C);
      const key = keyOf(r,c);
      if (!bigMap.has(key)) { bigMap.set(key, []); bigKeys.push(key); }
      bigMap.get(key).push(p);
    }

    for (const key of bigKeys) {
      bigMap.get(key).sort((a,b)=>(b.likesCount||0)-(a.likesCount||0));
    }

    if (bigKeys.length < BIG_R * BIG_C) {
      const existing = new Set(bigKeys);
      for (let r=0;r<BIG_R;r++){
        for (let c=0;c<BIG_C;c++){
          const key = keyOf(r,c);
          if (existing.has(key)) continue;

          const latMin = latMinG + (latSpanG/BIG_R)*r;
          const latMax = latMinG + (latSpanG/BIG_R)*(r+1);
          const lngMin = lngMinG + (lngSpanG/BIG_C)*c;
          const lngMax = lngMinG + (lngSpanG/BIG_C)*(c+1);

          const cand = photos.find(p=>{
            const la=Number(p.latitude), ln=Number(p.longitude);
            return la>=latMin && la<=latMax && ln>=lngMin && ln<=lngMax;
          });
          if (cand){
            bigMap.set(key,[cand]); bigKeys.push(key); existing.add(key);
          }
        }
      }
    }

    const selected = [];
    const selectedIds = new Set();
    let used = 0;
    for (const key of bigKeys) {
      if (used >= limit) break;
      const arr = bigMap.get(key);
      if (arr && arr.length>0) {
        selected.push(arr[0]);
        selectedIds.add(arr[0].id);
        used++;
      }
    }
    if (used >= limit) return selected.slice(0,limit);

    const remaining = photos.filter(p=>!selectedIds.has(p.id));
    if (remaining.length===0) return selected;
    const remainingLimit = limit - used;

    const buildGrid = (rows, cols, list) => {
      const gridMap = new Map(), keys=[];
      for (const p of list){
        const lat=Number(p.latitude), lng=Number(p.longitude);
        if (!this._isValidLatLng(lat, lng)) continue;
        const [r,c] = toCellRC(lat,lng,rows,cols);
        const k = keyOf(r,c);
        if(!gridMap.has(k)) {gridMap.set(k,[]); keys.push(k);}
        gridMap.get(k).push(p);
      }
      return {rows, cols, gridMap, cellKeys: keys};
    };

    let rows = GLOBAL_GRID_START_ROWS;
    let cols = GLOBAL_GRID_START_COLS;
    let grid = buildGrid(rows, cols, remaining);

    while (
      grid.cellKeys.length > remainingLimit &&
      (rows > GLOBAL_GRID_MIN_ROWS || cols > GLOBAL_GRID_MIN_COLS)
    ) {
      const newRows = Math.max(GLOBAL_GRID_MIN_ROWS, Math.floor(rows / 2));
      const newCols = Math.max(GLOBAL_GRID_MIN_COLS, Math.floor(cols / 2));
      const newMap = new Map(), newKeys=[];

      for (const key of grid.cellKeys){
        const [rStr,cStr]=key.split(','), r=Number(rStr), c=Number(cStr);
        const nr = Math.max(0, Math.min(newRows-1, Math.floor(r * newRows / rows)));
        const nc = Math.max(0, Math.min(newCols-1, Math.floor(c * newCols / cols)));
        const nk = keyOf(nr,nc);
        if(!newMap.has(nk)){newMap.set(nk,[]); newKeys.push(nk);}
        const arr = grid.gridMap.get(key)||[];
        newMap.get(nk).push(...arr);
      }
      rows=newRows; cols=newCols;
      grid = {rows, cols, gridMap:newMap, cellKeys:newKeys};
    }

    for (const k of grid.cellKeys){
      grid.gridMap.get(k).sort((a,b)=>(b.likesCount||0)-(a.likesCount||0));
    }

    const extra=[], idxMap={}; let extraUsed=0;
    for (const k of grid.cellKeys){
      if (extraUsed>=remainingLimit) break;
      const arr = grid.gridMap.get(k);
      if (arr && arr.length>0){ extra.push(arr[0]); idxMap[k]=1; extraUsed++; }
    }
    while (extraUsed<remainingLimit){
      let any=false;
      for (const k of grid.cellKeys){
        if (extraUsed>=remainingLimit) break;
        const arr=grid.gridMap.get(k), idx=idxMap[k]||0;
        if (arr && idx<arr.length){ extra.push(arr[idx]); idxMap[k]=idx+1; extraUsed++; any=true; }
      }
      if(!any) break;
    }

    return selected.concat(extra);
  },

  // ========= 区域图片半屏弹层（不影响 markers，不改 loading） =========
  openRegionPanel() {
    const scale = Number.isFinite(this._scale) ? this._scale : (this.data.scale || 4);
    if (scale < SCALE_REGION_PANEL) {
      wx.showToast({
        title: '当前区域太大了，请放大到城市级别再查看',
        icon: 'none'
      });
      return;
    }
    this._collectPhotosFromServerForCurrentRegion();
  },

  closeRegionPanel() {
    this.setData({ showRegionPanel: false, regionPhotos: [] });
  },

  async _collectPhotosFromServerForCurrentRegion() {
    if (!this.mapCtx) this.mapCtx = wx.createMapContext('map');

    const getBox = () => new Promise((resolve) => {
      this.mapCtx.getRegion({
        success: (res) => {
          const { southwest, northeast } = res || {};
          let box = null;
          if (southwest && northeast) {
            box = {
              minLat: Math.min(southwest.latitude, northeast.latitude),
              maxLat: Math.max(southwest.latitude, northeast.latitude),
              minLng: Math.min(southwest.longitude, northeast.longitude),
              maxLng: Math.max(southwest.longitude, northeast.longitude)
            };
          }
          box = this._normalizeBox(box);
          if (this._isValidBox(box)) {
            this.setData({ _lastRegionBox: box });
            resolve(box);
          } else {
            resolve(this.data._lastRegionBox || null);
          }
        },
        fail: () => {
          resolve(this.data._lastRegionBox || null);
        }
      });
    });

    const box = await getBox();
    const db = wx.cloud.database();
    const _ = db.command;

    const conds = [{ status: 'APPROVED' }];
    if (this._isValidBox(box)) {
      conds.push(
        { latitude: _.gte(box.minLat).and(_.lte(box.maxLat)) },
        { longitude: _.gte(box.minLng).and(_.lte(box.maxLng)) }
      );
    }
    this._appendRoleNameCond(conds, _);

    try {
      const WANT = 200;
      const MAX_PAGES = Math.ceil(WANT / DB_PAGE_LIMIT);
      let skip = 0;
      let hasMore = true;
      const listAll = [];

      for (let i = 0; i < MAX_PAGES && hasMore; i++) {
        const res = await db.collection(COLLECTION_PUBLISH)
          .where(_.and(conds))
          .orderBy('_id', 'desc')
          .skip(skip)
          .limit(DB_PAGE_LIMIT)
          .get();

        const list = res.data || [];
        listAll.push(...list);
        if (list.length < DB_PAGE_LIMIT) hasMore = false;
        skip += DB_PAGE_LIMIT;
      }

      const regionList = listAll.slice(0, WANT).map(p => {
        const thumb = this._pickRegionThumb(p);
        return {
          id: String(p._id || p.id),
          thumb,
          locationName: (p.locationName || '').slice(0, 40)
        };
      });

      this.setData({ regionPhotos: regionList, showRegionPanel: true });
    } catch (e) {
      console.warn('[collectRegionPhotos] failed:', e);
      this.setData({ regionPhotos: [], showRegionPanel: true });
    }
  },

  _pickRegionThumb(p) {
    const candidates = [
      p.thumbUrl,
      p.thumbFileID,
      p.originUrl,
      p.originFileID,
      p.roundThumbUrl,
      p.roundThumbFileID,
      DEFAULT_MARKER_ICON
    ];
    for (const s of candidates) {
      if (typeof s === 'string' && s.length > 0) return s;
    }
    return DEFAULT_MARKER_ICON;
  },

  onRegionPhotoTap(e) {
    const id = e.currentTarget?.dataset?.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/photo/photo?photoId=${id}` });
  },

  // ========= 初始获取兜底 =========
  async _fetchAllApprovedFromPublish() {
    const db = wx.cloud.database();

    const WANT = INITIAL_FETCH_LIMIT;
    const MAX_PAGES = Math.ceil(WANT / DB_PAGE_LIMIT);

    let all = [];
    let skip = 0;
    let hasMore = true;

    for (let i = 0; i < MAX_PAGES && hasMore; i++) {
      const res = await db.collection(COLLECTION_PUBLISH)
        .where({ status: 'APPROVED' })
        .orderBy('_id', 'desc')
        .skip(skip)
        .limit(DB_PAGE_LIMIT)
        .get();

      const list = res.data || [];
      all = all.concat(list);
      if (list.length < DB_PAGE_LIMIT) hasMore = false;
      skip += DB_PAGE_LIMIT;
    }

    return all.slice(0, WANT);
  },

  _sizeFromLikes(likes) {
    const min = this.data._likesMin;
    const max = this.data._likesMax;
    if (max <= min) return MIN_SIZE;
    const t = (Number(likes) - min) / (max - min);
    return Math.round(MIN_SIZE + t * (MAX_SIZE - MIN_SIZE));
  },

  _markerIdFromPhotoId(photoId) {
    const s = String(photoId || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return (h >>> 0) % 2147483647 || 1;
  },

  _isValidLatLng(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
           lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  },

  _dedupByGeoAndIcon(list) {
    const seen = new Set();
    const out = [];
    for (const p of list) {
      const icon = p.iconUrl || DEFAULT_MARKER_ICON;
      const key = `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}|${icon}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  },

  _capDenseListToLimit(list, limit) {
    const total = list.length;
    if (total <= limit) return list;

    const dropCount = total - limit;
    if (dropCount <= 0) return list;

    const GRID = DENSE_REGION_GRID_DEG;
    const cellMap = {};

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const cellX = Math.floor(p.latitude / GRID);
      const cellY = Math.floor(p.longitude / GRID);
      const key = `${cellX},${cellY}`;
      if (!cellMap[key]) cellMap[key] = [];
      cellMap[key].push(i);
    }

    const cells = Object.keys(cellMap);
    cells.sort((a, b) => cellMap[b].length - cellMap[a].length);

    const toDrop = new Set();
    let remaining = dropCount;

    for (const key of cells) {
      if (remaining <= 0) break;
      const idxList = cellMap[key];
      if (!idxList || idxList.length === 0) continue;

      idxList.sort((i1, i2) => {
        const l1 = list[i1].likesCount || 0;
        const l2 = list[i2].likesCount || 0;
        return l1 - l2;
      });

      for (const idx of idxList) {
        if (remaining <= 0) break;
        if (!toDrop.has(idx)) {
          toDrop.add(idx);
          remaining--;
        }
      }
    }

    if (remaining > 0) {
      for (let i = 0; i < list.length && remaining > 0; i++) {
        if (!toDrop.has(i)) {
          toDrop.add(i);
          remaining--;
        }
      }
    }

    return list.filter((p, idx) => !toDrop.has(idx));
  },

  // ====== 这里是改动点：分页抓 100 条角色 ======
  async loadRoles() {
    try {
      const now = Date.now();
      const cached = wx.getStorageSync(ROLES_CACHE_KEY);
      if (
        cached &&
        cached.time &&
        (now - cached.time) < ROLES_CACHE_TTL &&
        Array.isArray(cached.roles)
      ) {
        this.setData({ roleList: cached.roles });
        return;
      }

      const db = wx.cloud.database();
      const PAGE = 20;
      const MAX_TOTAL = 100;
      const rounds = Math.ceil(MAX_TOTAL / PAGE);

      let all = [];
      for (let i = 0; i < rounds; i++) {
        const res = await db.collection(COLLECTION_ROLES)
          .orderBy('order', 'asc')
          .skip(i * PAGE)
          .limit(PAGE)
          .get();

        const list = res.data || [];
        all = all.concat(list);
        if (list.length < PAGE) break;
      }

      const roles = all.slice(0, MAX_TOTAL).map(r => ({
        id: String(r._id || r.id),
        name: r.name || r.roleName || '未命名角色'
      }));

      this.setData({ roleList: roles });
      wx.setStorageSync(ROLES_CACHE_KEY, { time: now, roles });
    } catch (e) {
      this.setData({ roleList: [] });
    }
  },

  _pickIconUrl(p) {
    const candidates = [
      p.roundThumbUrl,
      p.thumbUrl,
      p.originUrl,
      p.roundThumbFileID,
      p.thumbFileID,
      p.originFileID
    ];
    for (const s of candidates) {
      if (typeof s === 'string' && s.length > 0) return s;
    }
    return '';
  },

  _mapDbRecordToPhoto(p) {
    if (!p) return null;
    const roleIds = Array.isArray(p.roleIds) ? p.roleIds.map(String) : [];

    const iconUrl = this._pickIconUrl(p);

    const likedBy = Array.isArray(p.likedBy) ? p.likedBy : [];
    const likesCount = Number(
      p.likesCount != null ? p.likesCount : likedBy.length
    );
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);

    if (!this._isValidLatLng(lat, lng)) return null;

    return {
      id: String(p._id || p.id),
      latitude: lat,
      longitude: lng,

      iconUrl: iconUrl || DEFAULT_MARKER_ICON,

      originUrl: p.originUrl || p.originFileID || '',
      originFileID: p.originFileID || '',
      thumbUrl: p.thumbUrl || p.thumbFileID || '',
      thumbFileID: p.thumbFileID || '',
      roundThumbUrl: p.roundThumbUrl || p.roundThumbFileID || '',
      roundThumbFileID: p.roundThumbFileID || '',

      roleIds,
      roleNames: Array.isArray(p.roleNames) ? p.roleNames : [],
      locationName: p.locationName || '',
      message: p.message || '',
      likesCount
    };
  },

  async loadApprovedPhotos(options = {}) {
    const { forceRefresh = false } = options || {};
    const now = Date.now();

    // ✅ 开始加载：第二行显示“加载中...”
    this.setData({ isLoadingMarkers: true });

    try {
      if (!forceRefresh) {
        const cache = wx.getStorageSync(HOME_PHOTOS_CACHE_KEY);
        if (
          cache &&
          cache.time &&
          (now - cache.time) < PHOTOS_CACHE_TTL &&
          Array.isArray(cache.photos)
        ) {
          this.setData(
            {
              _allPhotos: cache.photos,
              _likesMin: cache.likesMin || 0,
              _likesMax: cache.likesMax || 0
            },
            () => this._updateCountFromCurrentRegion()
          );
          return;
        }
      }

      await this._loadGlobalDistributedSample();
      this._updateCountFromCurrentRegion();
    } catch (e) {
      console.warn('[loadApprovedPhotos] failed:', e);
      this.setData({
        _allPhotos: [],
        markers: [],
        markerMap: {},
        _likesMin: 0,
        _likesMax: 0,
        isLoadingMarkers: false
      });
    }
  },

  // ====== 渲染 markers ======
  applyRoleFilterAndRender(regionBox) {
    const { _allPhotos, checkedRoleIdSet } = this.data;
    const activeRoleIds = Object.keys(checkedRoleIdSet).filter(id => checkedRoleIdSet[id]);

    const filtered0 = activeRoleIds.length === 0
      ? _allPhotos
      : _allPhotos.filter(p => (p.roleIds || []).some(rid => checkedRoleIdSet[rid]));

    const filtered1 = filtered0.filter(p => this._isValidLatLng(p.latitude, p.longitude));

    let baseList;
    if (this._isValidBox(regionBox)) {
      baseList = this._filterByBox(filtered1, regionBox);
    } else {
      baseList = filtered1;
    }

    const scale = Number.isFinite(this._scale) ? this._scale : (this.data.scale || 4);
    const isMinRegion = scale >= SCALE_REGION_PANEL;

    if (!isMinRegion && baseList.length > MAX_VIEW_MARKERS) {
      baseList = this._capDenseListToLimit(baseList, MAX_VIEW_MARKERS);
    }

    const deduped = this._dedupByGeoAndIcon(baseList);

    // 兜底：如果渲染列表为空，而当前模式是 mid/global，则尝试按视窗再拉一次，避免“空白”
    if (deduped.length === 0) {
      const box = this._isValidBox(regionBox) ? regionBox : this.data._lastRegionBox;
      if (this._isValidBox(box)) {
        this.setData({ isLoadingMarkers: true });
        this._loadGlobalBoxPhotos(box);
        return;
      }
    }

    const markerMap = {};
    const markers = deduped.map(p => {
      const mid = this._markerIdFromPhotoId(p.id);
      markerMap[mid] = String(p.id);
      const size = this._sizeFromLikes(p.likesCount);
      const icon = p.iconUrl || DEFAULT_MARKER_ICON;
      return {
        id: mid,
        latitude: p.latitude,
        longitude: p.longitude,
        iconPath: icon,
        width: size,
        height: size
      };
    });

    // ✅ 渲染完成：关闭“加载中...”
    this.setData({ markers, markerMap, isLoadingMarkers: false });
  },

  onMarkerTap(e) {
    const mid = Number(e.markerId);
    const photoId = this.data.markerMap[mid];
    if (!photoId) {
      wx.showToast({ title: '未找到图片', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/photo/photo?photoId=${photoId}` });
  },

  goToPublish() { wx.navigateTo({ url: '/pages/publish/publish' }); },

  goToGuess() {
    wx.navigateTo({ url: '/pages/guess/guess' });
  },

  goToActivity() {
    wx.navigateTo({ url: '/pages/activity/activity' });
  },

  // ====== 改动点：筛选按钮 → 随机进入一张图片 ======
  openFilter() {
    const markerMap = this.data.markerMap || {};
    const markerPhotoIds = Object.values(markerMap).filter(id => !!id);

    let candidateIds = markerPhotoIds;

    if (!candidateIds || candidateIds.length === 0) {
      const list = this.data._allPhotos || [];
      if (!list.length) {
        wx.showToast({ title: '暂时没有可随机的照片', icon: 'none' });
        return;
      }
      const idx = Math.floor(Math.random() * list.length);
      const p = list[idx];
      if (!p || !p.id) {
        wx.showToast({ title: '暂时没有可随机的照片', icon: 'none' });
        return;
      }
      wx.navigateTo({ url: `/pages/photo/photo?photoId=${p.id}` });
      return;
    }

    const idx = Math.floor(Math.random() * candidateIds.length);
    const photoId = candidateIds[idx];
    if (!photoId) {
      wx.showToast({ title: '随机失败，请重试', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/photo/photo?photoId=${photoId}` });
  },

  closeFilter() { this.setData({ showFilterPanel: false }); },
  onRoleCheckChange(e) { /* no-op */ },
  resetFilter() { /* no-op */ },

  // ====== 刷新按钮（5 秒限频）→ 强制“按当前视图重排” ======
  onRefreshRegionTap() {
    const now = Date.now();
    if (this._lastRefreshTs && (now - this._lastRefreshTs) < 5000) {
      wx.showToast({ title: '操作太频繁，请稍后再试', icon: 'none' });
      return;
    }
    this._lastRefreshTs = now;
    this.setData({ isLoadingMarkers: true });
    this._rebalanceCurrentView();
  },

  // ====== 强制按当前视图重排（全国和中间也生效） ======
  async _rebalanceCurrentView() {
    if (!this.mapCtx) this.mapCtx = wx.createMapContext('map');

    const box = await new Promise((resolve) => {
      this.mapCtx.getRegion({
        success: (res) => {
          const { southwest, northeast } = res || {};
          let b = null;
          if (southwest && northeast) {
            b = {
              minLat: Math.min(southwest.latitude, northeast.latitude),
              maxLat: Math.max(southwest.latitude, northeast.latitude),
              minLng: Math.min(southwest.longitude, northeast.longitude),
              maxLng: Math.max(southwest.longitude, northeast.longitude)
            };
          }
          b = this._normalizeBox(b);
          if (this._isValidBox(b)) {
            this.setData({ _lastRegionBox: b });
            resolve(b);
          } else {
            resolve(this.data._lastRegionBox || null);
          }
        },
        fail: () => resolve(this.data._lastRegionBox || null)
      });
    });

    if (!this._isValidBox(box)) {
      await this._loadGlobalDistributedSample();
      wx.showToast({ title: '已全局重排', icon: 'none' });
      return;
    }

    const cachedAll = this._getRoleFiltered();
    let inBox = this._filterByBox(cachedAll, box);

    if (!Array.isArray(inBox) || inBox.length < REFRESH_CACHE_MIN) {
      const db = wx.cloud.database();
      const _  = db.command;

      const conds = [
        { status: 'APPROVED' },
        { latitude: _.gte(box.minLat).and(_.lte(box.maxLat)) },
        { longitude: _.gte(box.minLng).and(_.lte(box.maxLng)) }
      ];
      this._appendRoleNameCond(conds, _);

      const totalWanted = REFRESH_PAGE_LIMIT * REFRESH_MAX_ROUNDS; // 500
      const rounds = Math.ceil(totalWanted / DB_PAGE_LIMIT);       // 25

      const tasks = [];
      for (let i = 0; i < rounds; i++) {
        tasks.push(
          db.collection(COLLECTION_PUBLISH)
            .where(_.and(conds))
            .orderBy('_id', 'desc')
            .skip(i * DB_PAGE_LIMIT)
            .limit(DB_PAGE_LIMIT)
            .get()
        );
      }

      try {
        const results = await Promise.all(tasks);
        const raw = [];
        results.forEach(r => raw.push(...(r.data || [])));

        const merged = [];
        const idSet = new Set();
        for (const p of raw) {
          const m = this._mapDbRecordToPhoto(p);
          if (!m || idSet.has(m.id)) continue;
          idSet.add(m.id);
          if (m.latitude >= box.minLat && m.latitude <= box.maxLat &&
              m.longitude >= box.minLng && m.longitude <= box.maxLng) {
            merged.push(m);
          }
        }
        inBox = merged;
      } catch (err) {
        console.warn('[refresh/box fetch] failed:', err);
        inBox = Array.isArray(inBox) ? inBox : [];
      }
    }

    const target = Math.min(MAX_VIEW_MARKERS, Array.isArray(inBox) ? inBox.length : 0);
    const evenly = this._distributeGlobalPhotosEvenly(inBox || [], target, box);

    if (!evenly || evenly.length === 0) {
      await this._loadGlobalBoxPhotos(box);
      wx.showToast({ title: '已重排（按视窗拉取）', icon: 'none' });
      return;
    }

    let likesMin = 0, likesMax = 0;
    if (evenly.length > 0) {
      likesMin = evenly.reduce((m, p) => Math.min(m, p.likesCount), evenly[0].likesCount);
      likesMax = evenly.reduce((m, p) => Math.max(m, p.likesCount), evenly[0].likesCount);
    }

    this.setData(
      { _allPhotos: evenly, _likesMin: likesMin, _likesMax: likesMax },
      () => this.applyRoleFilterAndRender(null)
    );

    wx.showToast({ title: '已按当前视图重排', icon: 'none' });
  },

  applyFilter() {
    this.openFilter();
  }
});
