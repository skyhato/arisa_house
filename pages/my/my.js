/**
 * 页面：my
 *
 * 作用：
 * 1. 展示当前用户头像、昵称、UID
 * 2. 修复旧头像残留问题：页面展示缓存后，会再主动拉一次数据库最新用户信息
 * 3. 消息通知小红点
 * 4. 支持我们入口可关闭
 *
 * 本次重点修复：
 * - 不再把本地缓存当成头像最终来源
 * - 只要已登录，就会去 users 集合读取最新 nickname / avatar / uid
 * - 对远程头像增加版本参数，尽量避免旧图缓存
 */

const COLLECTION_USERS = 'users'

Page({
  data: {
    user: null,
    defaultAvatar: '../../assets/default-avatar.png',

    // 消息通知小红点
    hasNewNotice: false,

    // 支持我们是否开放
    supportEnabled: false
  },

  onLoad() {
    this._avatarTempCache = Object.create(null)
    this._loadUserFromCache()
    this.checkNewNotice()
  },

  onShow() {
    this._loadUserFromCache()
    this.checkNewNotice()
  },

  /* ========== 从缓存读取并立刻展示，再异步刷新最新用户资料 ========== */
  _loadUserFromCache() {
    try {
      const cached = wx.getStorageSync('user')

      if (cached && typeof cached === 'object') {
        const user = this._normalizeUser(cached)

        // 先展示缓存，避免页面空白
        this.setData({ user })

        // 再异步刷新数据库最新资料，修复旧头像/旧昵称/旧uid问题
        this._refreshLatestUser(user)
      } else {
        this.setData({ user: null })
      }
    } catch (e) {
      console.warn('[my] load user from storage error:', e)
      this.setData({ user: null })
    }
  },

  _normalizeUser(user) {
    const u = { ...(user || {}) }
    u.openid = u.openid || u.openId || ''
    u.uid = u.uid || ''
    u.nickname = u.nickname || ''
    u.avatar = u.avatar || u.avatarFileID || u.avatarUrl || ''
    u.avatarUrlResolved = u.avatarUrlResolved || ''
    return u
  },

  /* ========== 读取本地是否有新消息 ========== */
  checkNewNotice() {
    const flag = wx.getStorageSync('hasNewNotice')
    this.setData({
      hasNewNotice: !!flag
    })
  },

  /* ========== 刷新最新用户资料，优先修复头像 / 昵称 / uid ========== */
  async _refreshLatestUser(localUser) {
    try {
      if (!localUser || !localUser.openid) {
        this.setData({ user: null })
        return
      }

      const latestUserDoc = await this._fetchLatestUserDoc(localUser.openid)

      // 查不到数据库资料时，退回缓存用户，但也尝试重新解析头像
      if (!latestUserDoc) {
        const fallback = { ...localUser }
        fallback.avatarUrlResolved = await this._resolveAvatar(
          fallback.avatar,
          fallback.updatedAt || fallback.createdAt || Date.now()
        )

        wx.setStorageSync('user', fallback)
        this.setData({ user: fallback })
        return
      }

      const mergedUser = {
        ...localUser,
        ...latestUserDoc
      }

      mergedUser.openid = mergedUser.openid || mergedUser._openid || localUser.openid || ''
      mergedUser.uid = mergedUser.uid || ''
      mergedUser.nickname = mergedUser.nickname || ''
      mergedUser.avatar =
        mergedUser.avatar ||
        mergedUser.avatarFileID ||
        mergedUser.avatarUrl ||
        ''

      mergedUser.avatarUrlResolved = await this._resolveAvatar(
        mergedUser.avatar,
        mergedUser.updatedAt || mergedUser.createdAt || Date.now()
      )

      wx.setStorageSync('user', mergedUser)
      this.setData({ user: mergedUser })
    } catch (e) {
      console.warn('[my] refresh latest user error:', e)
    }
  },

  /* ========== 从 users 集合读取最新用户文档 ========== */
  async _fetchLatestUserDoc(openid) {
    try {
      const db = wx.cloud.database()

      // 优先按 openid 查
      const res = await db.collection(COLLECTION_USERS)
        .where({ openid: String(openid) })
        .limit(1)
        .get()

      if (res.data && res.data[0]) {
        return res.data[0]
      }

      // 兼容极少数旧数据
      const res2 = await db.collection(COLLECTION_USERS)
        .where({ _openid: String(openid) })
        .limit(1)
        .get()

      return (res2.data && res2.data[0]) || null
    } catch (e) {
      console.warn('[my] fetch latest user doc error:', e)
      return null
    }
  },

  /* ========== 解析头像，尽量避免旧图缓存 ========== */
  async _resolveAvatar(src, versionTag) {
    if (!src || typeof src !== 'string') return ''

    const raw = src.trim()
    if (!raw) return ''

    // cloud:// 文件
    if (raw.startsWith('cloud://')) {
      const cached = this._avatarTempCache[raw]
      if (cached) return cached

      try {
        const { fileList } = await wx.cloud.getTempFileURL({ fileList: [raw] })
        const temp = (fileList && fileList[0] && fileList[0].tempFileURL) || ''
        if (temp) {
          this._avatarTempCache[raw] = temp
        }
        return temp
      } catch (e) {
        console.warn('[my] getTempFileURL error:', e)
        return ''
      }
    }

    // http / https
    if (/^https?:\/\//i.test(raw)) {
      let url = raw
      if (url.startsWith('http://')) {
        url = 'https://' + url.slice('http://'.length)
      }

      // 附加版本参数，尽量避免头像缓存导致仍显示旧图
      const v = versionTag ? String(versionTag) : String(Date.now())
      return url.includes('?') ? `${url}&_v=${v}` : `${url}?_v=${v}`
    }

    // 本地文件 / data URL
    if (
      raw.startsWith('wxfile://') ||
      raw.startsWith('file://') ||
      raw.startsWith('data:')
    ) {
      return raw
    }

    // 项目内静态资源
    if (
      raw.startsWith('/') ||
      raw.startsWith('./') ||
      raw.startsWith('../')
    ) {
      return raw
    }

    return ''
  },

  onAvatarError() {
    const { user, defaultAvatar } = this.data
    if (!user) return

    const nextUser = { ...user, avatarUrlResolved: defaultAvatar }

    try {
      wx.setStorageSync('user', nextUser)
    } catch (e) {
      console.warn('[my] avatar error, save user failed:', e)
    }

    this.setData({ user: nextUser })
  },

  navTo(url) {
    wx.navigateTo({
      url,
      fail() {
        wx.showToast({ title: '页面未找到', icon: 'none' })
      }
    })
  },

  goProfile() {
    this.navTo('/pages/profile/profile')
  },

  goWorks() {
    this.navTo('/pages/works/works')
  },

  goNotice() {
    wx.setStorageSync('hasNewNotice', false)
    this.setData({ hasNewNotice: false })
    this.navTo('/pages/notice/notice')
  },

  goFeatured() {
    this.navTo('/pages/featured/featured')
  },

  // 支持我们暂时关闭
  goSupport() {
    wx.showToast({
      title: '暂未开放',
      icon: 'none'
    })
  },

  goLogin() {
    this.navTo('/pages/login/login')
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (!res.confirm) return

        try {
          wx.removeStorageSync('user')
        } catch (e) {}

        this.setData({ user: null })
        wx.showToast({ title: '已退出', icon: 'none' })
      }
    })
  }
})