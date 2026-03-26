// pages/featured/featured.js
// 展示精选照片：仅 status='APPROVED' 且 isFeatured=true 的作品
// 依赖集合：publish
// 依赖云函数：toggleLike

const COLLECTION_PUBLISH = 'publish';
const PAGE_SIZE = 10;

Page({
  data: {
    items: [],
    loading: false,
    hasMore: true,
    page: 0,
    defaultThumb: '/assets/default-avatar.png',

    // 仅用于前端判断是否点过赞
    openid: '',
  },

  onLoad() {
    // 从本地缓存拿用户信息，保存 openid，便于判断 hasLiked
    const user = wx.getStorageSync('user') || {};
    const openid = user.openid || user.openId || '';
    this._openid = openid; // 非响应字段
    this.setData({ openid });

    this._loadFeatured(true);
  },

  onPullDownRefresh() {
    this._loadFeatured(true).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this._loadFeatured(false);
    }
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this._loadFeatured(false);
  },

  /** 加载精选作品：reset=true 代表重置分页 */
  async _loadFeatured(reset = false) {
    if (this.data.loading) return;
    this.setData({ loading: true });

    const db = wx.cloud.database();
    const _ = db.command;

    let page = this.data.page;
    if (reset) {
      page = 0;
    }

    try {
      const where = {
        status: 'APPROVED',
        // 兼容多种“精选”写法：布尔 true / 字符串 'true' / 数字 1
        isFeatured: _.in([true, 'true', 1]),
      };

      const res = await db.collection(COLLECTION_PUBLISH)
        .where(where)
        .orderBy('likesCount', 'desc')
        .orderBy('createdAt', 'desc')
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .field({
          thumbUrl: true,
          thumbFileID: true,
          originFileID: true,

          avatarUrl: true,
          avatar: true,
          avatarFileID: true,
          nickname: true,
          nicknameMasked: true, // 如果你有这个字段

          locationName: true,
          message: true,
          likesCount: true,
          likedBy: true,
          createdAt: true,
          createTime: true,
        })
        .get();

      const list = res.data || [];
      const mapped = list.map(doc => this._mapDocToItem(doc));

      let newItems;
      if (reset) {
        newItems = mapped;
      } else {
        newItems = (this.data.items || []).concat(mapped);
      }

      this.setData({
        items: newItems,
        page: page + 1,
        hasMore: list.length === PAGE_SIZE,
      });
    } catch (e) {
      console.error('[featured] 加载精选失败：', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 将 publish 文档映射为页面 item */
  _mapDocToItem(doc) {
    const id = doc._id || doc.id || '';
    const thumbUrl = doc.thumbUrl || doc.thumbFileID || doc.originFileID || '';
    const avatarUrl = doc.avatarUrl || doc.avatar || doc.avatarFileID || this.data.defaultThumb;
    const nickname = doc.nicknameMasked || this._maskNickname(doc.nickname);
    const locationName = doc.locationName || '';
    const message = doc.message || '';
    const likesCount = doc.likesCount || 0;
    const createdAt = doc.createdAt || doc.createTime || null;

    // === 计算当前用户是否已点赞 ===
    const openid = this._openid || this.data.openid || '';
    const likedBy = Array.isArray(doc.likedBy) ? doc.likedBy : [];
    const hasLiked = !!(openid && likedBy.includes(openid));

    return {
      id,
      thumbUrl,
      imageUrl: doc.originFileID || thumbUrl,
      avatarUrl,
      nicknameMasked: nickname,
      locationName,
      message,
      likesCount,
      createdAtText: this._formatTime(createdAt),

      // 前端状态：是否已点赞
      hasLiked,
    };
  },

  /** 昵称打码：只保留前后字符，中间全部 *；两个字时只保留最后一个 */
  _maskNickname(name) {
    if (!name || typeof name !== 'string') return '匿名用户';
    const len = name.length;
    if (len === 1) return '*';
    if (len === 2) return '*' + name[1];
    // len >= 3：首尾保留，中间打 *
    return name[0] + '*'.repeat(len - 2) + name[len - 1];
  },

  /** 时间格式化：YYYY-MM-DD 或空 */
  _formatTime(t) {
    if (!t) return '';
    let d;
    if (t instanceof Date) {
      d = t;
    } else if (t && t.toDate) {
      // 云开发时间戳
      d = t.toDate();
    } else {
      d = new Date(t);
    }
    if (!d || isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${y}-${pad(m)}-${pad(day)}`;
  },

  /** 查看详情：跳到 photo 页面 */
  goPhoto(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/photo/photo?id=${id}`,
    });
  },

  /** 点赞：调用 toggleLike 云函数，乐观更新 + 防止无限点赞 */
  onToggleLike(e) {
    const id = e.currentTarget.dataset.id;
    const index = e.currentTarget.dataset.index;
    if (!id && index === undefined) return;

    // 简单登录检查：直接从缓存取 openid（和你其它页保持一致）
    const user = wx.getStorageSync('user') || {};
    const openid = user.openid || user.openId || '';
    if (!openid) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }

    // 请求过程中防连点
    if (this._liking) return;
    this._liking = true;

    const items = this.data.items.slice();
    const item = items[index];
    if (!item) {
      this._liking = false;
      return;
    }

    const prevLiked = !!item.hasLiked;
    const prevLikes = item.likesCount || 0;

    // 前端乐观切换：已点赞 -> 取消；未点赞 -> 点赞
    const nextLiked = !prevLiked;
    let nextLikes = prevLikes + (nextLiked ? 1 : -1);
    if (nextLikes < 0) nextLikes = 0;

    item.hasLiked = nextLiked;
    item.likesCount = nextLikes;
    items[index] = item;

    this.setData({ items });

    wx.cloud.callFunction({
      name: 'toggleLike',
      data: { photoId: id },
    }).then(res => {
      // 如果云函数返回准确的 likesCount，就对齐一下，避免前后端不一致
      const serverCount = res && res.result && typeof res.result.likesCount === 'number'
        ? res.result.likesCount
        : null;
      if (serverCount !== null) {
        this.setData({
          [`items[${index}].likesCount`]: serverCount,
        });
      }
    }).catch(err => {
      console.error('[featured] toggleLike 失败：', err);
      // 回滚本地状态
      item.hasLiked = prevLiked;
      item.likesCount = prevLikes;
      items[index] = item;
      this.setData({ items });
      wx.showToast({ title: '点赞失败', icon: 'none' });
    }).finally(() => {
      this._liking = false;
    });
  },
});
