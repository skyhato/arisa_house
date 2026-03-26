// pages/my/my.js
const COLLECTION_USERS = 'users';

Page({
  data: {
    user: null,
    // 默认头像：相对路径写法（假设 assets/ 在项目根目录）
    defaultAvatar: '../../assets/default-avatar.png',

    // 消息通知小红点
    hasNewNotice: false
  },

  onLoad() {
    this._loadUserFromCache();
    this.checkNewNotice();
  },

  onShow() {
    this._loadUserFromCache();
    this.checkNewNotice();
  },

  // 从本地缓存加载用户，并做一次 hydrate
  _loadUserFromCache() {
    try {
      const cached = wx.getStorageSync('user');
      if (cached && typeof cached === 'object') {
        // 异步补全头像 / 昵称等信息，不阻塞页面
        this._hydrateUser(cached);
      } else {
        this.setData({ user: null });
      }
    } catch (e) {
      console.warn('[my] load user from storage error:', e);
      this.setData({ user: null });
    }
  },

  // 读取本地是否有新消息的标记
  checkNewNotice() {
    const flag = wx.getStorageSync('hasNewNotice'); // 其他页面有新消息时置为 true
    this.setData({
      hasNewNotice: !!flag
    });
  },

  async _hydrateUser(user) {
    try {
      if (!user || typeof user !== 'object') {
        this.setData({ user: null });
        return;
      }

      user.openid = user.openid || user.openId || '';

      // ⚠️ 优先级调整：avatar > avatarFileID > avatarUrl
      const rawCandidate =
        user.avatar ||
        user.avatarFileID ||
        user.avatarUrl ||
        '';

      let resolved = await this._ensureHttpsAvatar(rawCandidate);

      // 如果解析不到，去 users 集合兜底（这一段按你要求不改动）
      if (!resolved && user.openid) {
        const db = wx.cloud.database();
        let uDoc = null;

        try {
          const r = await db.collection(COLLECTION_USERS).doc(String(user.openid)).get();
          uDoc = r.data || null;
        } catch (_) {}

        if (!uDoc) {
          const r2 = await db.collection(COLLECTION_USERS)
            .where({ openid: String(user.openid) })
            .limit(1)
            .get();
          uDoc = (r2.data && r2.data[0]) || null;
        }

        if (uDoc) {
          // 取出 avatar 字段（你数据库就是这个）
          user.nickname = user.nickname || uDoc.nickname || '';
          user.avatar = uDoc.avatar || uDoc.avatarFileID || uDoc.avatarUrl || '';
          resolved = await this._ensureHttpsAvatar(user.avatar);
        }
      }

      user.avatarUrlResolved = resolved || '';
      wx.setStorageSync('user', user);
      this.setData({ user });
    } catch (e) {
      console.warn('[my] hydrate error:', e);
      this.setData({ user });
    }
  },

  async _ensureHttpsAvatar(src) {
    if (!src || typeof src !== 'string') return '';

    // 去掉前后空格，防止奇怪的字符串
    src = src.trim();
    if (!src) return '';

    // 云存储 fileID：cloud:// 开头
    if (src.startsWith('cloud://')) {
      try {
        const { fileList } = await wx.cloud.getTempFileURL({ fileList: [src] });
        return (fileList && fileList[0] && fileList[0].tempFileURL) || '';
      } catch (e) {
        console.warn('[my] getTempFileURL error:', e);
        return '';
      }
    }

    // 远程 http/https
    if (/^https?:\/\//i.test(src)) {
      // 强制把 http:// 升级为 https://，避免小程序不让加载
      if (src.startsWith('http://')) {
        return 'https://' + src.slice('http://'.length);
      }
      return src;
    }

    // 本地文件 / data URL
    if (
      src.startsWith('wxfile://') ||
      src.startsWith('file://') ||
      src.startsWith('data:')
    ) {
      return src;
    }

    // 项目内静态资源（例如 /assets/xxx.png，或相对路径 ../images/xxx.png）
    if (
      src.startsWith('/') ||      // /assets/xxx.png
      src.startsWith('./') ||     // ./assets/xxx.png
      src.startsWith('../')       // ../assets/xxx.png
    ) {
      return src;
    }

    // 其他奇怪格式一律视为无效
    return '';
  },

  onAvatarError() {
    const { user, defaultAvatar } = this.data;
    if (!user) return;

    user.avatarUrlResolved = defaultAvatar;

    // 同步回本地缓存，避免每次进入页面都重复加载失败
    try {
      wx.setStorageSync('user', user);
    } catch (e) {
      console.warn('[my] avatar error, save user failed:', e);
    }

    this.setData({ user });
  },

  navTo(url) {
    wx.navigateTo({
      url,
      fail() {
        wx.showToast({ title: '页面未找到：' + url, icon: 'none' });
      }
    });
  },

  goProfile() { this.navTo('/pages/profile/profile'); },
  goWorks()   { this.navTo('/pages/works/works'); },

  // 进入消息通知时，顺便把小红点清掉
  goNotice()  {
    wx.setStorageSync('hasNewNotice', false);
    this.setData({ hasNewNotice: false });
    this.navTo('/pages/notice/notice');
  },

  // 支持我们（原“联系我”改名）
  goSupport() { this.navTo('/pages/contact/contact'); },

  // 赞助列表
  goSponsorList() { this.navTo('/pages/sponsor-list/sponsor-list'); },

  // 登录 / 注册
  goLogin() {
    this.navTo('/pages/login/login');
  },

  // 精选照片页
  goFeatured() {
    this.navTo('/pages/featured/featured');
  },

  // 退出登录
  onLogout() {
    const that = this;
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmColor: '#ff4d4f',
      success(res) {
        if (res.confirm) {
          try {
            wx.removeStorageSync('user');
          } catch (e) {}
          that.setData({ user: null });
          wx.showToast({ title: '已退出', icon: 'none' });
        }
      }
    });
  }
});
