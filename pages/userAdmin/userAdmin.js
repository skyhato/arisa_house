/**
 * 页面：userAdmin
 *
 * 作用：
 * 1. 管理员分页查看用户列表
 * 2. 支持按注册时间 / 作品数排序
 * 3. 支持按昵称 / openid 搜索
 * 4. 支持删除用户及其作品
 * 5. 支持运行 fixUsersUid 云函数
 * 6. 列表展示 uid
 *
 * 本次优化：
 * 1. 单页数量从 100 调整为 40，减轻首屏压力
 * 2. 先渲染文字数据，再异步补头像，不阻塞首屏
 * 3. 增加头像临时链接缓存，减少重复 getTempFileURL
 * 4. 增加请求版本号，避免异步返回覆盖新数据
 */

const PAGE_SIZE = 40
const PUBLISH_COLL = 'publish'
const USERS_COLL = 'users'

Page({
  data: {
    loading: false,
    loadingMore: false,
    runningFix: false,

    // 排序与搜索
    sortMode: 'time', // 'time' | 'works'
    searchKey: '',

    // 分页
    page: 0,
    pageSize: PAGE_SIZE,
    items: [],
    hasMore: true,

    // 顶部统计
    total: 0
  },

  onLoad() {
    this._avatarTempCache = Object.create(null)
    this._requestToken = 0
    this.checkAdminAndLoad()
  },

  /* ========== 管理员校验后加载 ========== */
  async checkAdminAndLoad() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({ name: 'checkAdmin' })
      const ret = res.result || {}
      if (!ret.isAdmin) {
        wx.showToast({ title: '无权访问', icon: 'none' })
        setTimeout(() => {
          const pages = getCurrentPages()
          if (pages.length > 1) wx.navigateBack()
          else wx.switchTab({ url: '/pages/index/index' })
        }, 800)
        return
      }
      await this.reloadFirstPage()
    } catch (err) {
      console.error('[userAdmin] checkAdmin error:', err)
      wx.showToast({ title: '校验失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /* ========== 搜索 & 排序 ========== */
  onSearchInput(e) {
    this.setData({ searchKey: e.detail.value || '' })
  },

  onSearchConfirm() {
    this.reloadFirstPage()
  },

  onChangeSort(e) {
    const mode = e.currentTarget.dataset.mode
    if (!mode || mode === this.data.sortMode) return
    this.setData({ sortMode: mode }, () => this.reloadFirstPage())
  },

  /* ========== 运行去重补 UID ========== */
  onRunFixUsersUid() {
    if (this.data.runningFix) return

    wx.showModal({
      title: '确认执行',
      content: '将调用 fixUsersUid 云函数。请先确认云函数里的 DRY_RUN 设置是否正确。继续吗？',
      confirmText: '执行',
      success: async (r) => {
        if (!r.confirm) return

        this.setData({ runningFix: true })
        wx.showLoading({
          title: '执行中',
          mask: true
        })

        try {
          const res = await wx.cloud.callFunction({
            name: 'fixUsersUid',
            data: {}
          })

          const result = res.result || {}
          console.log('[userAdmin] fixUsersUid result:', result)

          if (!result.dryRun) {
            await this.reloadFirstPage()
          }

          wx.hideLoading()

          wx.showModal({
            title: result.dryRun ? '试跑完成' : '执行完成',
            content:
              '模式：' + (result.dryRun ? '试跑' : '正式执行') +
              '\n总文档：' + (result.totalDocsBefore ?? '-') +
              '\n有效用户：' + (result.validUsers ?? '-') +
              '\n待删重复：' + (result.duplicateDocsToDelete ?? '-') +
              '\n缺少openid：' + (result.invalidDocsWithoutOpenid ?? '-') +
              '\nUID范围：' + (
                Array.isArray(result.uidRange) && result.uidRange.length === 2
                  ? `${result.uidRange[0]} - ${result.uidRange[1]}`
                  : '-'
              ),
            showCancel: false
          })
        } catch (err) {
          wx.hideLoading()
          console.error('[userAdmin] fixUsersUid error:', err)
          wx.showModal({
            title: '执行失败',
            content: err.message || JSON.stringify(err),
            showCancel: false
          })
        } finally {
          this.setData({ runningFix: false })
        }
      }
    })
  },

  /* ========== 重新加载第一页 ========== */
  async reloadFirstPage() {
    this._requestToken += 1
    this.setData({ page: 0, items: [], hasMore: true })
    await this.loadPage(0)
  },

  /* ========== 给当前批次先补一个可立即显示的 avatarResolved ========== */
  _applyAvatarResolved(arr, start = 0, end = arr.length) {
    const list = arr.slice()

    for (let i = start; i < end; i++) {
      const it = list[i] || {}
      const src = it.avatar || it.avatarUrl || it.avatarURL || ''

      if (!src) {
        list[i] = { ...it, avatarResolved: '' }
        continue
      }

      if (typeof src === 'string' && src.startsWith('cloud://')) {
        const cached = this._avatarTempCache[src]
        list[i] = { ...it, avatarResolved: cached || '' }
      } else {
        list[i] = { ...it, avatarResolved: src }
      }
    }

    return list
  },

  /* ========== 异步补头像，不阻塞首屏 ========== */
  async _resolveAvatarTempURLs(arr, start = 0, end = arr.length, requestToken = 0) {
    try {
      const needConvert = []

      for (let i = start; i < end; i++) {
        const it = arr[i] || {}
        const src = it.avatar || it.avatarUrl || it.avatarURL || ''
        if (
          typeof src === 'string' &&
          src.startsWith &&
          src.startsWith('cloud://') &&
          !this._avatarTempCache[src]
        ) {
          needConvert.push({ idx: i, fileID: src })
        }
      }

      if (!needConvert.length) return

      const BATCH = 20
      for (let k = 0; k < needConvert.length; k += BATCH) {
        const sub = needConvert.slice(k, k + BATCH)
        const fileList = sub.map(x => x.fileID)

        try {
          const ret = await wx.cloud.getTempFileURL({ fileList })
          const rlist = ret.fileList || []

          const patch = {}
          sub.forEach((x, idx) => {
            const temp = rlist[idx] && rlist[idx].tempFileURL ? rlist[idx].tempFileURL : ''
            if (temp) {
              this._avatarTempCache[x.fileID] = temp
              patch[`items[${x.idx}].avatarResolved`] = temp
            }
          })

          if (requestToken === this._requestToken && Object.keys(patch).length) {
            this.setData(patch)
          }
        } catch (err) {
          console.warn('[userAdmin] getTempFileURL batch error:', err)
        }
      }
    } catch (e) {
      console.error('[userAdmin] _resolveAvatarTempURLs error:', e)
    }
  },

  /* ========== 加载某一页（从 0 开始） ========== */
  async loadPage(page) {
    if (!this.data.hasMore && page !== 0) return

    const token = ++this._requestToken
    const { sortMode, searchKey, pageSize } = this.data
    this.setData(page === 0 ? { loading: true } : { loadingMore: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'adminListUsers',
        data: { page, pageSize, sortMode, searchKey }
      })

      if (token !== this._requestToken) return

      const ret = res.result || {}
      if (!ret.ok) {
        wx.showToast({ title: ret.msg || '拉取失败', icon: 'none' })
        return
      }

      const list = ret.items || []
      let merged = page === 0 ? list : this.data.items.concat(list)

      const startIdx = page === 0 ? 0 : (merged.length - list.length)
      const endIdx = merged.length

      // 先立即补上能同步显示的 avatarResolved，再渲染
      merged = this._applyAvatarResolved(merged, startIdx, endIdx)

      const hasMore = typeof ret.hasMore === 'boolean'
        ? ret.hasMore
        : (list.length === pageSize)

      this.setData({
        items: merged,
        page,
        hasMore,
        total: typeof ret.total === 'number' ? ret.total : this.data.total
      })

      // 再异步补 cloud:// 头像，不阻塞首屏
      this._resolveAvatarTempURLs(merged, startIdx, endIdx, token)
    } catch (e) {
      console.error('[userAdmin] loadPage error:', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      if (token === this._requestToken) {
        this.setData({ loading: false, loadingMore: false })
      }
    }
  },

  /* ========== 加载更多（下一页） ========== */
  onLoadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return
    const next = this.data.page + 1
    this.loadPage(next)
  },

  /* ========== 删除用户及其所有作品 ========== */
  onDeleteUser(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return

    wx.showModal({
      title: '确认操作',
      content: '确定要删除该用户及其所有作品吗？此操作不可恢复！',
      confirmColor: '#ff4d4f',
      success: (r) => {
        if (r.confirm) this._deleteUserAndPhotos(openid)
      }
    })
  },

  async _deleteUserAndPhotos(openid) {
    this.setData({ loading: true })
    const db = wx.cloud.database()

    try {
      // 1) 分批拉取该用户所有作品并逐个调用 deletePhoto
      const BATCH = 50
      let skip = 0
      for (;;) {
        const res = await db.collection(PUBLISH_COLL)
          .where({ openid: String(openid) })
          .skip(skip)
          .limit(BATCH)
          .get()

        const list = res.data || []
        for (const p of list) {
          try {
            await wx.cloud.callFunction({
              name: 'deletePhoto',
              data: { photoId: String(p._id) }
            })
          } catch (err) {
            console.error('[userAdmin] deletePhoto failed:', p._id, err)
          }
        }

        if (list.length < BATCH) break
        skip += BATCH
      }

      // 2) 删除用户文档（兼容 docId / where）
      try {
        await db.collection(USERS_COLL).doc(String(openid)).remove()
      } catch (_) {
        const found = await db.collection(USERS_COLL).where({ openid: String(openid) }).limit(1).get()
        if (found.data && found.data[0]) {
          await db.collection(USERS_COLL).doc(found.data[0]._id).remove()
        }
      }

      wx.showToast({ title: '已删除该用户', icon: 'success' })

      // 3) 本地移除
      const items = (this.data.items || []).filter(u => u.openid !== openid)
      this.setData({
        items,
        total: Math.max(0, (this.data.total || 0) - 1)
      })
    } catch (e) {
      console.error('[userAdmin] deleteUser error:', e)
      wx.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /* ========== 底部返回 ========== */
  onBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/profile/profile' })
  }
})