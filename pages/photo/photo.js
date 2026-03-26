// pages/photo/photo.js
// 功能：展示发布内容、点赞/评论、管理编辑（地点/留言/角色）
// 约定：保存编辑后 -> 将作品 status 置为 'PENDING' 并提示需重新审核
// 依赖集合：publish, users, comments, app_config, roles
// 依赖云函数：toggleLike, checkAdmin, getUserProfileMasked, deletePhoto, updatePhotoMeta(新增)

const COLLECTION_PUBLISH  = 'publish';
const COLLECTION_USERS    = 'users';
const COLLECTION_COMMENTS = 'comments';
const COLLECTION_CONFIG   = 'app_config';
const COLLECTION_ROLES    = 'roles';

// ✅ 活动集合
const COLLECTION_ACTIVITIES = 'activities';

const HOME_PHOTOS_CACHE_KEY = 'home_photos_cache_v1';

const DEFAULT_AVATAR = '/assets/default-avatar.png';

// ✅ 本地缓存 key 与 TTL（用于减少重复云请求）
const USER_PROFILE_CACHE_PREFIX = 'user_profile_masked_cache_v1_';
const USER_AVATAR_CACHE_PREFIX  = 'user_avatar_cache_v1_';
const USER_CACHE_TTL_MS         = 6 * 60 * 60 * 1000; // 6小时
const TEMP_URL_FALLBACK_TTL_MS  = 12 * 60 * 60 * 1000; // 12小时（getTempFileURL没给maxAge时的兜底）

Page({
  data: {
    photoId: '',

    // 用户
    avatarUrl: '',
    nickname: '',
    rawNickname: '',

    // 图片
    imageUrl: '',

    // 地点
    locationName: '',
    latitude: null,
    longitude: null,

    // 地点卡片下的角色tag展示
    roleTags: [],

    // 留言
    message: '',

    // 点赞
    likesCount: 0,
    hasLiked: false,
    isLiking: false,

    // 本人 openid
    myOpenId: '',

    // 全局：评论/留言开关
    commentEnabled: false,

    /* 评论相关 */
    comments: [],
    commentInput: '',
    sendingComment: false,
    loadingComments: false,
    commentsFinished: false,
    commentsPageSize: 10,
    commentsAnchorTime: null,

    /* 权限相关 */
    uploaderOpenid: '',
    canDelete: false,
    deletingPhoto: false,
    canEdit: false,
    isAdmin: false,         // 是否管理员（用于头像点击切换精选）

    /* 编辑面板 */
    editing: false,
    savingEdit: false,
    roleList: [],
    editSelectedRoleIds: {},   // { roleId: true/false }

    editLocationName: '',
    editMessage: '',
    editLatitude: null,
    editLongitude: null,

    /* 昵称隐私开关 */
    showPrivacyMask: true,

    /* 精选标记 */
    isFeatured: false,       // 当前照片是否为精选照片

    /* 活动信息（若该照片属于活动） */
    isActivity: false,
    activityName: '',
    activityCoverUrl: ''
  },

  /* ============ 生命周期 ============ */
  onLoad(options) {
    const photoId = options?.photoId || options?.id || '';
    if (!photoId) {
      wx.showToast({ title: '缺少 photoId', icon: 'none' });
      return;
    }
    const user = wx.getStorageSync('user') || {};
    const myOpenId = user.openid || user.openId || '';

    this.setData({ photoId, myOpenId }, async () => {
      await this.loadGlobalConfig();
      await this.loadDetail(photoId);
      if (this.data.commentEnabled) await this.loadComments(true);
    });
  },

  onShow() {
    const user = wx.getStorageSync('user') || {};
    const myOpenId = user.openid || user.openId || '';
    if (myOpenId && myOpenId !== this.data.myOpenId) {
      this.setData({ myOpenId });
      if (this.data.uploaderOpenid) this._updateDeletePermission(this.data.uploaderOpenid);
    }
  },

  /* ============ 工具函数 ============ */
  _maskNickname(name) {
    if (!name) return '';
    const str = String(name);
    if (!this.data.showPrivacyMask) return str;
    const len = str.length;
    if (len === 1) return '*';
    if (len === 2) return '*' + str[1];
    return str[0] + '*'.repeat(len - 2) + str[len - 1];
  },

  onTogglePrivacy() {
    const next = !this.data.showPrivacyMask;
    const rawNick = this.data.rawNickname || this.data.nickname || '';
    const displayNick = next ? this._maskNickname(rawNick) : rawNick;
    const newComments = (this.data.comments || []).map(it => {
      const raw = it.rawNickname || it.nickname || '';
      return { ...it, rawNickname: raw, nickname: next ? this._maskNickname(raw) : raw };
    });
    this.setData({ showPrivacyMask: next, nickname: displayNick, comments: newComments });
  },

  async loadGlobalConfig() {
    const db = wx.cloud.database();
    try {
      const res = await db.collection(COLLECTION_CONFIG).limit(1).get();
      const cfg = (res.data && res.data[0]) || {};
      this.setData({ commentEnabled: !!cfg.commentEnabled });
    } catch {
      this.setData({ commentEnabled: false });
    }
  },

  _pickCloudIds(list) {
    return (list || []).filter(id => typeof id === 'string' && id.startsWith('cloud://'));
  },

  // 临时链接缓存（避免同一 fileID 反复 getTempFileURL）
  async _toTempUrls(fileIds) {
    const ids = this._pickCloudIds(fileIds);
    if (!ids.length) return {};

    // 内存缓存：this._tempUrlCache = { [fileID]: { url, expireAt } }
    if (!this._tempUrlCache) this._tempUrlCache = {};

    const now = Date.now();
    const map = {};
    const need = [];

    ids.forEach(id => {
      const c = this._tempUrlCache[id];
      if (c && c.url && c.expireAt && c.expireAt > now + 60 * 1000) { // 留1分钟余量
        map[id] = c.url;
      } else {
        need.push(id);
      }
    });

    if (!need.length) return map;

    try {
      const { fileList } = await wx.cloud.getTempFileURL({ fileList: need });
      (fileList || []).forEach(f => {
        const url = f.tempFileURL || '';
        if (!url) return;
        map[f.fileID] = url;

        const maxAgeSec = Number(f.maxAge) || 0;
        const expireAt = maxAgeSec ? (now + maxAgeSec * 1000) : (now + TEMP_URL_FALLBACK_TTL_MS);
        this._tempUrlCache[f.fileID] = { url, expireAt };
      });
      return map;
    } catch {
      return map;
    }
  },

  _resolveUrl(maybeIdOrUrl, id2urlMap) {
    if (!maybeIdOrUrl || typeof maybeIdOrUrl !== 'string') return '';
    if (/^https?:\/\//i.test(maybeIdOrUrl)) return maybeIdOrUrl;
    if (maybeIdOrUrl.startsWith('cloud://')) return id2urlMap[maybeIdOrUrl] || '';
    return '';
  },

  // 用户资料本地缓存（减少云函数调用）
  async _readUserProfile(openid) {
    if (!openid) return {};

    const key = USER_PROFILE_CACHE_PREFIX + String(openid);
    try {
      const cached = wx.getStorageSync(key);
      if (cached && cached.expireAt && cached.expireAt > Date.now() && cached.data) {
        return cached.data || {};
      }
    } catch {}

    try {
      const res = await wx.cloud.callFunction({ name: 'getUserProfileMasked', data: { openid: String(openid) } });
      const r = res?.result || {};
      if (!r.ok) return {};
      const data = { avatarUrl: r.avatarUrl || '', nicknameRaw: r.nicknameRaw || '', nicknameMasked: r.nicknameMasked || '' };

      try {
        wx.setStorageSync(key, { expireAt: Date.now() + USER_CACHE_TTL_MS, data });
      } catch {}

      return data;
    } catch {
      return {};
    }
  },

  // 读取 users 表里的“当前头像”（优先用这个）+本地缓存
  async _readUserCurrentAvatar(openid) {
    if (!openid) return '';

    const key = USER_AVATAR_CACHE_PREFIX + String(openid);
    try {
      const cached = wx.getStorageSync(key);
      if (cached && cached.expireAt && cached.expireAt > Date.now() && typeof cached.avatar === 'string') {
        return cached.avatar || '';
      }
    } catch {}

    const db = wx.cloud.database();
    try {
      const res = await db.collection(COLLECTION_USERS).where({ openid: String(openid) }).limit(1).get();
      const u = (res.data && res.data[0]) || null;
      if (!u) return '';
      // users 表字段兜底
      const avatar = u.avatarUrl || u.avatar || u.avatarFileID || '';

      try {
        wx.setStorageSync(key, { expireAt: Date.now() + USER_CACHE_TTL_MS, avatar });
      } catch {}

      return avatar;
    } catch {
      return '';
    }
  },

  _fmtTime(ts) {
    if (!ts) return '';
    const d = ts instanceof Date ? ts : new Date(ts);
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  /* ============ 图片预览 / 下载 ============ */

  // 点图直接预览
  onPreviewPhoto() {
    let url = this.data.imageUrl || '';
    if (!url) return;

    // 兜底：如果还拿到 cloud://，先转临时链接再预览
    if (typeof url === 'string' && url.startsWith('cloud://')) {
      this._toTempUrls([url]).then(map => {
        const u = map[url] || '';
        if (!u) {
          wx.showToast({ title: '图片加载失败', icon: 'none' });
          return;
        }
        wx.previewImage({ urls: [u], current: u });
      });
      return;
    }

    wx.previewImage({ urls: [url], current: url });
  },

  onImageTap() {
    const url = this.data.imageUrl || '';
    if (!url) return;

    wx.showActionSheet({
      itemList: ['预览大图', '保存到相册'],
      success: (res) => {
        if (res.tapIndex === 0) this._previewImage();
        if (res.tapIndex === 1) this._downloadImage();
      }
    });
  },

  _previewImage() {
    const url = this.data.imageUrl || '';
    if (!url) return;
    wx.previewImage({ urls: [url], current: url });
  },

  async _downloadImage() {
    let url = this.data.imageUrl || '';
    if (!url) return;

    wx.showLoading({ title: '下载中...' });

    try {
      // 如果意外拿到 cloud://，先转临时链接
      if (typeof url === 'string' && url.startsWith('cloud://')) {
        const map = await this._toTempUrls([url]);
        url = map[url] || '';
      }
      if (!url) {
        wx.hideLoading();
        wx.showToast({ title: '图片链接无效', icon: 'none' });
        return;
      }

      const dl = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url,
          success: resolve,
          fail: reject
        });
      });

      const filePath = dl?.tempFilePath || '';
      if (!filePath) {
        wx.hideLoading();
        wx.showToast({ title: '下载失败', icon: 'none' });
        return;
      }

      const ensureAuth = async () => {
        const setting = await new Promise(resolve => wx.getSetting({ success: resolve, fail: () => resolve({}) }));
        const auth = setting?.authSetting || {};
        if (auth['scope.writePhotosAlbum']) return true;

        // 未授权 -> 申请
        try {
          await new Promise((resolve, reject) => {
            wx.authorize({
              scope: 'scope.writePhotosAlbum',
              success: resolve,
              fail: reject
            });
          });
          return true;
        } catch {
          // 用户拒绝 -> 引导去设置
          wx.hideLoading();
          wx.showModal({
            title: '需要授权',
            content: '保存图片需要相册权限，请在设置中开启「保存到相册」权限。',
            confirmText: '去设置',
            cancelText: '取消',
            success: (r) => {
              if (!r.confirm) return;
              wx.openSetting({});
            }
          });
          return false;
        }
      };

      const ok = await ensureAuth();
      if (!ok) return;

      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath,
          success: resolve,
          fail: reject
        });
      });

      wx.hideLoading();
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch {
      wx.hideLoading();
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  /* ============ ✅ 活动识别（只认显式 activityId） ============ */
  async _loadActivityMeta(publishDoc) {
    const db = wx.cloud.database();

    // 先清空，保证默认是普通照片（白卡片）
    this.setData({
      isActivity: false,
      activityName: '',
      activityCoverUrl: ''
    });

    if (!publishDoc) return;

    // 按你可能的字段名兜底取活动 ID
    const activityId =
      publishDoc.activityId ||
      publishDoc.activity_id ||
      (publishDoc.activity && publishDoc.activity._id) ||
      '';

    // 没有关联活动 -> 直接返回，保持 isActivity=false
    if (!activityId) {
      return;
    }

    try {
      // 用活动 id 精确查询
      const res = await db.collection(COLLECTION_ACTIVITIES)
        .doc(String(activityId))
        .get();

      const act = res.data || null;
      // 没查到或被禁用，就当普通照片
      if (!act || act.enabled === false) {
        return;
      }

      // 处理封面
      const rawCover = act.coverUrl || act.cover || '';
      let coverUrl = '';

      if (typeof rawCover === 'string' && rawCover.startsWith('cloud://')) {
        const map = await this._toTempUrls([rawCover]);
        coverUrl = map[rawCover] || '';
      } else if (typeof rawCover === 'string' && /^https?:\/\//i.test(rawCover)) {
        coverUrl = rawCover;
      }

      this.setData({
        isActivity: true,
        activityName: act.name || '活动照片',
        activityCoverUrl: coverUrl
      });
    } catch (e) {
      // 查询失败也不要误标为活动
      this.setData({
        isActivity: false,
        activityName: '',
        activityCoverUrl: ''
      });
    }
  },

  /* ============ 数据加载 ============ */
  async loadDetail(photoId) {
    const db = wx.cloud.database();
    try {
      const { data: p } = await db.collection(COLLECTION_PUBLISH).doc(String(photoId)).get();

      // 识别是否活动照片（并取活动封面）
      await this._loadActivityMeta(p);

      const rawImageId =
        p.originUrl ||
        p.originFileID || p.originFileId ||
        p.thumbUrl ||
        p.thumbFileID  || p.thumbFileId || '';

      let publishAvatar = p.avatarUrl || p.avatar || '';
      const uploaderOpenid = String(p.openid || p.userId || p._openid || '');

      // 始终读取 users 表当前头像；拿不到再回退到发布记录头像
      const currentAvatarFromUsers = await this._readUserCurrentAvatar(uploaderOpenid);

      let userProfile = {};
      if (!currentAvatarFromUsers) userProfile = await this._readUserProfile(uploaderOpenid);

      const userAvatarFromProfile = userProfile.avatarUrl || '';

      const nicknameRawFromProfile = userProfile.nicknameRaw || '';
      const nicknameMaskedFromProfile = userProfile.nicknameMasked || '';

      const rawNickname = p.nickname || nicknameRawFromProfile || '匿名用户';
      const displayNickname = this.data.showPrivacyMask
        ? (nicknameMaskedFromProfile || this._maskNickname(rawNickname))
        : rawNickname;

      const avatarPick = currentAvatarFromUsers || userAvatarFromProfile || publishAvatar || '';

      const id2url = await this._toTempUrls([rawImageId, publishAvatar, currentAvatarFromUsers, userAvatarFromProfile]);
      const imageUrl  = this._resolveUrl(rawImageId, id2url);
      const avatarUrl =
        this._resolveUrl(avatarPick, id2url) ||
        this._resolveUrl(publishAvatar, id2url) ||
        DEFAULT_AVATAR;

      const likedBy    = Array.isArray(p.likedBy) ? p.likedBy.map(String) : [];
      const likesCount = Number(p.likesCount != null ? p.likesCount : likedBy.length) || 0;
      const hasLiked   = this.data.myOpenId ? likedBy.includes(this.data.myOpenId) : false;

      // 初始化角色勾选 map（只读新数据：roleIds）
      const roleIds = Array.isArray(p.roleIds) ? p.roleIds.map(String) : [];
      const roleIdSet = {}; roleIds.forEach(id => roleIdSet[id] = true);

      // 详情页展示的角色tag（优先用 publish 里的 roleNames；没有就用 roleIds 去 roles 表补）
      let roleTags = Array.isArray(p.roleNames) ? p.roleNames.filter(Boolean).map(String) : [];
      if (!roleTags.length && roleIds.length) {
        try {
          const _ = db.command;
          const rr = await db.collection(COLLECTION_ROLES)
            .where({ _id: _.in(roleIds) })
            .field({ name: true })
            .get();
          roleTags = (rr.data || []).map(x => x.name).filter(Boolean);
        } catch {
          roleTags = [];
        }
      }

      // 精选字段：支持 isFeatured / featured
      const isFeatured = !!(p.isFeatured || p.featured);

      this.setData({
        imageUrl,
        avatarUrl,
        rawNickname,
        nickname: displayNickname,
        locationName: p.locationName || '',
        latitude: p.latitude ?? null,
        longitude: p.longitude ?? null,

        roleTags,

        message: p.message || '',
        likesCount,
        hasLiked,
        uploaderOpenid,
        isFeatured,          // 记录精选状态到页面

        // 编辑副本初始化
        editLocationName: p.locationName || '',
        editMessage: p.message || '',
        editLatitude: p.latitude ?? null,
        editLongitude: p.longitude ?? null,
        editSelectedRoleIds: roleIdSet
      });

      this._updateDeletePermission(uploaderOpenid);
    } catch (e) {
      const msg = e?.errMsg || e?.message || String(e);
      if (/permission denied/i.test(msg)) {
        wx.showToast({ title: '暂无读取权限', icon: 'none' });
      } else if (/document does not exist/i.test(msg)) {
        wx.showToast({ title: '图片不存在', icon: 'none' });
      } else {
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    }
  },

  async _checkIsAdmin() {
    try {
      const res = await wx.cloud.callFunction({ name: 'checkAdmin' });
      const r = res?.result || {};
      return !!(r.ok && r.isAdmin);
    } catch {
      return false;
    }
  },

  // 更新删除/编辑权限 & 管理员标记
  async _updateDeletePermission(uploaderOpenid) {
    const { myOpenId } = this.data;
    if (!myOpenId || !uploaderOpenid) {
      this.setData({ canDelete: false, canEdit: false, isAdmin: false });
      return;
    }

    const isAdmin = await this._checkIsAdmin();
    const isOwner = String(myOpenId) === String(uploaderOpenid);

    this.setData({
      canDelete: isOwner || isAdmin,
      canEdit: isOwner || isAdmin,
      isAdmin: !!isAdmin
    });
  },

  /* ============ 顶部“精选照片”说明 ============ */
  onShowFeaturedIntro() {
    wx.showModal({
      title: '精选照片是什么',
      content:
        '“精选照片”会出现在「猜猜宝」玩法中。\n\n' +
        '被选为精选的照片需要满足：拍摄于户外、画面清晰，背景信息明确，方便根据环境来猜地点。\n\n' +
        '精选标记由管理员人工审核后添加。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 管理员点头像切换精选标记
  async onAvatarTap() {
    const { isAdmin, isFeatured, photoId } = this.data;
    if (!photoId) return;

    // 非管理员：不做任何操作
    if (!isAdmin) return;

    const next = !isFeatured;
    const title = next ? '标记为精选照片' : '取消精选标记';
    const content = next
      ? '确定将这张照片标记为“精选照片”吗？它有机会出现在「猜猜宝」玩法中。'
      : '确定取消这张照片的精选标记吗？';

    wx.showModal({
      title,
      content,
      confirmText: '确定',
      cancelText: '再想想',
      success: async (res) => {
        if (!res.confirm) return;

        try {
          const resp = await wx.cloud.callFunction({
            name: 'updatePhotoMeta',
            data: {
              photoId: String(photoId),
              isFeatured: next   // 只更新精选标记
            }
          });

          const r = resp?.result || {};
          if (!r.ok) {
            wx.showToast({ title: r.msg || '操作失败', icon: 'none' });
            return;
          }

          this.setData({ isFeatured: next });
          wx.showToast({
            title: next ? '已标记为精选' : '已取消精选',
            icon: 'success'
          });
        } catch (e) {
          wx.showToast({ title: '操作失败', icon: 'none' });
        }
      }
    });
  },

  /* ============ 点赞 ============ */
  async onLikeTap() {
    const { photoId, myOpenId, isLiking } = this.data;
    if (!photoId) return;
    if (!myOpenId) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    if (isLiking) return;

    this.setData({ isLiking: true });
    try {
      const resp = await wx.cloud.callFunction({ name: 'toggleLike', data: { photoId } });
      const r = resp?.result || {};
      if (!r.ok) { wx.showToast({ title: r.msg || '操作失败', icon: 'none' }); return; }
      this.setData({ hasLiked: r.liked, likesCount: r.likesCount });
    } catch {
      wx.showToast({ title: '网络异常', icon: 'none' });
    } finally {
      this.setData({ isLiking: false });
    }
  },

  /* ============ 评论 ============ */
  async loadComments(isFirst = false) {
    if (!this.data.commentEnabled) return;
    if (this.data.loadingComments || this.data.commentsFinished) return;
    const db = wx.cloud.database();
    const _ = db.command;
    this.setData({ loadingComments: true });

    try {
      let where = { photoId: String(this.data.photoId) };
      if (!isFirst && this.data.commentsAnchorTime) where.createdAt = _.lt(this.data.commentsAnchorTime);

      const res = await db.collection(COLLECTION_COMMENTS)
        .where(where).orderBy('createdAt', 'desc')
        .limit(this.data.commentsPageSize).get();

      const list = (res.data || []).map(it => {
        const rawNickname = it.nickname || '匿名用户';
        const displayNickname = this.data.showPrivacyMask ? this._maskNickname(rawNickname) : rawNickname;
        const createdAtDate = it.createdAt ? (it.createdAt instanceof Date ? it.createdAt : new Date(it.createdAt)) : null;
        return {
          _id: it._id,
          content: it.content || '',
          avatarUrl: it.avatarUrl || DEFAULT_AVATAR,
          rawNickname,
          nickname: displayNickname,
          createdAt: createdAtDate,
          createdAtText: it.createdAt ? this._fmtTime(it.createdAt) : ''
        };
      });

      const newAnchor = list.length ? list[list.length - 1].createdAt : this.data.commentsAnchorTime;
      this.setData({
        comments: isFirst ? list : this.data.comments.concat(list),
        commentsAnchorTime: newAnchor || this.data.commentsAnchorTime,
        commentsFinished: list.length < this.data.commentsPageSize
      });
    } catch {
      wx.showToast({ title: '评论加载失败', icon: 'none' });
    } finally {
      this.setData({ loadingComments: false });
    }
  },

  onLoadMoreComments() {
    if (!this.data.commentsFinished) this.loadComments(false);
  },

  onCommentInput(e) {
    this.setData({ commentInput: (e.detail.value || '').slice(0, 300) });
  },

  async onSubmitComment() {
    const { myOpenId, commentInput, photoId, sendingComment, commentEnabled } = this.data;
    if (!commentEnabled) return;

    const content = (commentInput || '').trim();
    if (sendingComment) return;
    if (!myOpenId) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    if (!content) {
      wx.showToast({ title: '请输入评论内容', icon: 'none' });
      return;
    }

    this.setData({ sendingComment: true });
    const db = wx.cloud.database();

    try {
      const cacheUser = wx.getStorageSync('user') || {};
      let avatarUrl = cacheUser.avatarUrl || cacheUser.avatar || '';
      let nickname  = cacheUser.nickname  || cacheUser.username || '';

      if (!avatarUrl || !nickname) {
        const profile = await this._readUserProfile(myOpenId);
        const rawFromProfile = profile.nicknameRaw || '';
        nickname = nickname || rawFromProfile || '';
        avatarUrl = avatarUrl || profile.avatarUrl || '';
      }

      if (!avatarUrl) avatarUrl = DEFAULT_AVATAR;
      if (!nickname)  nickname  = '匿名用户';

      const now = db.serverDate();
      const addRes = await db.collection(COLLECTION_COMMENTS).add({
        data: {
          photoId: String(photoId),
          openid: String(myOpenId),
          nickname,      // 存原始昵称
          avatarUrl,
          content,
          createdAt: now
        }
      });

      const rawNickname = nickname;
      const displayNickname = this.data.showPrivacyMask ? this._maskNickname(rawNickname) : rawNickname;

      const localItem = {
        _id: addRes?._id || Math.random().toString(36).slice(2),
        content,
        avatarUrl,
        rawNickname,
        nickname: displayNickname,
        createdAt: new Date(),
        createdAtText: this._fmtTime(new Date())
      };
      this.setData({ comments: [localItem].concat(this.data.comments), commentInput: '' });
      wx.showToast({ title: '已发布', icon: 'success' });
    } catch {
      wx.showToast({ title: '发布失败', icon: 'none' });
    } finally {
      this.setData({ sendingComment: false });
    }
  },

  /* ============ 删除照片 ============ */
  async onDeletePhotoTap() {
    const { photoId, deletingPhoto } = this.data;
    if (!photoId || deletingPhoto) return;

    wx.showModal({
      title: '删除确认',
      content: '将彻底删除这张照片及所有关联文件，且不可恢复。确定要删除吗？',
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ deletingPhoto: true });

        wx.cloud.callFunction({
          name: 'deletePhoto',
          data: { photoId }
        }).then(cfRes => {
          const r = cfRes?.result || {};
          if (!r.ok) {
            wx.showToast({ title: r.msg || '删除失败', icon: 'none' });
            this.setData({ deletingPhoto: false });
            return;
          }
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => {
            this.setData({ deletingPhoto: false });
            this.goBack();
          }, 600);
        }).catch(() => {
          wx.showToast({ title: '删除失败', icon: 'none' });
          this.setData({ deletingPhoto: false });
        });
      }
    });
  },

  /* ============ 编辑 ============ */

  // 全量读取角色（分页直到取完）；force=true 强制刷新
  async loadRoles(force = false) {
    if (!force && this.data.roleList && this.data.roleList.length) return;

    const db = wx.cloud.database();
    const PAGE_SIZE = 20;
    let all = [];
    let skip = 0;

    try {
      while (true) {
        const res = await db.collection(COLLECTION_ROLES)
          .where({ enabled: true })
          .orderBy('order', 'asc')
          .orderBy('name', 'asc')
          .skip(skip)
          .limit(PAGE_SIZE)
          .get();

        const list = res.data || [];
        all = all.concat(list);
        if (list.length < PAGE_SIZE) break;
        skip += list.length;
      }

      // 去重保护
      const uniqMap = {};
      const uniq = [];
      for (const r of all) {
        const id = String(r._id);
        if (!uniqMap[id]) { uniqMap[id] = 1; uniq.push(r); }
      }

      this.setData({ roleList: uniq });
    } catch {
      this.setData({ roleList: [] });
    }
  },

  // —— 编辑快照：进入编辑时记录当前“编辑副本”，取消时还原（避免未提交却写库）
  _makeSnapshot() {
    this._editSnapshot = {
      editLocationName: this.data.editLocationName,
      editMessage: this.data.editMessage,
      editLatitude: this.data.editLatitude,
      editLongitude: this.data.editLongitude,
      editSelectedRoleIds: { ...(this.data.editSelectedRoleIds || {}) }
    };
  },

  _restoreSnapshot() {
    const s = this._editSnapshot || null;
    if (!s) return;
    this.setData({
      editLocationName: s.editLocationName,
      editMessage: s.editMessage,
      editLatitude: s.editLatitude,
      editLongitude: s.editLongitude,
      editSelectedRoleIds: { ...(s.editSelectedRoleIds || {}) }
    });
  },

  // 进入编辑
  onStartEdit() {
    if (!this.data.canEdit) {
      wx.showToast({ title: '无权限编辑', icon: 'none' });
      return;
    }
    // 同步最新详情到编辑副本（确保从当前页面状态进入）
    this.setData({
      editLocationName: this.data.locationName || '',
      editMessage: this.data.message || '',
      editLatitude: this.data.latitude ?? null,
      editLongitude: this.data.longitude ?? null
    });

    // 拉取完整角色列表后再打开面板，生成快照
    this.loadRoles(true).then(() => {
      this._makeSnapshot();
      this.setData({ editing: true });
    });
  },

  // 取消编辑：仅还原本地副本，不触库
  onCancelEdit() {
    this._restoreSnapshot();
    this.setData({ editing: false });
  },

  // 选择位置（禁止手输）
  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        const name = res.name || res.address || '';
        this.setData({
          editLocationName: (name || '').slice(0, 80),
          editLatitude: res.latitude,
          editLongitude: res.longitude
        });
      },
      fail: (err) => {
        const msg = String(err?.errMsg || '');
        if (!/cancel/i.test(msg)) wx.showToast({ title: '选择位置失败', icon: 'none' });
      }
    });
  },

  onEditMessageInput(e) {
    this.setData({ editMessage: (e.detail.value || '').slice(0, 500) });
  },

  // 角色勾选：bindtap + data-id 翻转 map（只改本地副本）
  onToggleRole(e) {
    const id = String(e.currentTarget.dataset.id || e.target.dataset.id || e.detail.value || '');
    if (!id) return;
    const map = { ...(this.data.editSelectedRoleIds || {}) };
    map[id] = !map[id];
    this.setData({ editSelectedRoleIds: map });
  },

  // 保存：校验 -> 云函数更新数据库 -> 标记 PENDING -> 提示
  async onSaveEdit() {
    if (!this.data.canEdit) return;

    const locationName = (this.data.editLocationName || '').trim();
    const message = (this.data.editMessage || '').trim();

    if (locationName.length > 80) {
      wx.showToast({ title: '地点内容过长', icon: 'none' });
      return;
    }
    if (message.length > 500) {
      wx.showToast({ title: '留言过长', icon: 'none' });
      return;
    }

    // 角色校验
    const roleIdSet = this.data.editSelectedRoleIds || {};
    const roleIds = Object.keys(roleIdSet).filter(k => !!roleIdSet[k]);
    if (roleIds.length === 0) {
      wx.showToast({ title: '请至少选择一个角色', icon: 'none' });
      return;
    }

    // 角色名称映射（便于兼容旧列表展示）
    const id2name = {};
    (this.data.roleList || []).forEach(r => { id2name[String(r._id)] = r.name; });
    const roleNames = roleIds.map(id => id2name[id]).filter(Boolean);

    const latitude = this.data.editLatitude ?? null;
    const longitude = this.data.editLongitude ?? null;

    this.setData({ savingEdit: true });

    try {
      // 一次性更新所有字段（按新数据字段：roleIds/roleNames），并带上 isFeatured 防止被清掉
      const resp = await wx.cloud.callFunction({
        name: 'updatePhotoMeta',
        data: {
          photoId: String(this.data.photoId),
          locationName,
          message,
          roleIds,
          roleNames,
          latitude,
          longitude,
          isFeatured: !!this.data.isFeatured
        }
      });

      const r = resp?.result || {};
      if (!r.ok) {
        this.setData({ savingEdit: false });
        wx.showToast({ title: r.msg || '保存失败', icon: 'none' });
        return;
      }

      // 让“列表/首页缓存”失效，保证返回后能看到新数据
      wx.removeStorageSync(HOME_PHOTOS_CACHE_KEY);

      // 同步页面展示（本页立即更新）
      this.setData({
        locationName,
        message,
        latitude,
        longitude,

        // 详情页角色tag立即更新
        roleTags: roleNames,

        savingEdit: false,
        editing: false
      });

      // 保存成功后更新快照
      this._makeSnapshot();

      wx.showModal({
        title: '已提交修改',
        content: '信息已保存，作品已标记为“待审核”。审核通过后将重新展示。',
        showCancel: false,
        confirmText: '返回',
        success: (res) => {
          if (res.confirm) this.goBack();
        }
      });
    } catch (e) {
      this.setData({ savingEdit: false });
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  /* ============ 返回 ============ */
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  }
});
