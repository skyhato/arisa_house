// pages/guess/guess.js

const DAILY_FREE_TIMES = 3;
const STORAGE_KEY = 'guess_game_state_v1';
// 当前题目缓存（用于退出再回来仍是同一题）
const CURRENT_Q_KEY = 'guess_current_question_v1';

// 50km 判定阈值（单位：米）
const WIN_DISTANCE_M = 50 * 1000;

const db = wx.cloud.database();
const _ = db.command;

const COLLECTION_PUBLISH = 'publish';          // 照片集合
const COLLECTION_GUESS_STATS = 'guess_stats';  // 周统计集合

// 激励视频广告实例（全局单例）
let videoAd = null;
let hasBindVideoEvents = false; // 防止重复绑定 onClose/onError/onLoad

Page({
  data: {
    imageUrl: '',
    // 正确答案的经纬度（从 publish 记录里取）
    targetLat: null,
    targetLng: null,

    // 当前题目的照片信息
    currentPhotoId: '',
    currentLocationName: '',
    currentMessage: '',
    currentNickname: '',

    // 点赞信息（供结果弹窗使用）
    likeCount: 0,
    hasLiked: false,

    // 用户选择的地址
    guessLat: null,
    guessLng: null,
    guessLocationName: '',

    // 次数 & 状态
    remaining: 0,
    canSubmit: false,
    canWatchAd: true, // 后面要做次数限制可以再加逻辑

    // 本周战绩
    weeklyCorrect: 0,   // 本周猜对次数
    weeklyRank: '--',   // 本周排名
    weeklyDiff: '--',   // 距离上一名（张）

    // 本周前 5 名
    weeklyTopList: [],  // [{ rank, displayName, correctCount }]

    // 结果弹窗
    showResultPanel: false,

    // 内部使用
    _todayStr: '',
  },

  onLoad(options) {
    // 1. 每日次数（本地）
    const today = this._getTodayStr();
    this.data._todayStr = today;
    this._loadTodayState(today);

    // 2. 初始化激励视频广告（单例 + 只绑定一次事件）
    if (wx.createRewardedVideoAd) {
      if (!videoAd) {
        videoAd = wx.createRewardedVideoAd({
          adUnitId: 'adunit-c5d30cc09aa0404c'
        });
      }

      if (!hasBindVideoEvents && videoAd) {
        videoAd.onLoad(() => {});

        videoAd.onError((err) => {
          console.error('激励视频广告加载失败', err);
          wx.showToast({ title: '广告加载失败', icon: 'none' });
        });

        // 用箭头函数，this 指向 Page 实例
        videoAd.onClose((res) => {
          const ended = res && (res.isEnded === undefined || res.isEnded);
          if (ended) {
            // 看完广告，奖励 +1 次
            this._onAdReward();
          } else {
            wx.showToast({
              title: '完整看完才有奖励喔',
              icon: 'none',
            });
          }
        });

        hasBindVideoEvents = true;
      }
    }

    // 3. 初始化本周统计（周一清零）
    this._weekStartStr = this._getWeekStartStr();
    this._initWeeklyStats();

    // 4. 从 publish 抽题 或 恢复题目
    const photoId = options.photoId || '';
    if (photoId) {
      // 有指定 photoId：仍按原逻辑从数据库拉题
      this._loadFromPublishById(photoId);
    } else {
      // 无指定 photoId：优先尝试恢复本地缓存的“当前题目”
      const restored = this._restoreQuestionFromStorage(today);
      if (!restored) {
        this._loadRandomFromPublish();
      }
    }
  },

  /* ========== 从数据库加载题目 / 本地恢复题目 ========== */

  // 将 publish 文档写入当前题目 + 写入本地缓存
  _applyDocAsQuestion(doc) {
    // 判断当前用户是否已点赞（简单按 likedBy 包含 openid 来算）
    const openid = this._openid || '';
    let hasLiked = false;
    if (openid && Array.isArray(doc.likedBy)) {
      hasLiked = doc.likedBy.indexOf(openid) !== -1;
    }

    const todayStr = this.data._todayStr || this._getTodayStr();

    const payload = {
      todayStr,
      imageUrl: doc.originFileID,
      targetLat: doc.latitude,
      targetLng: doc.longitude,
      currentPhotoId: doc._id || '',
      currentLocationName: doc.locationName || '',
      currentMessage: doc.message || '',
      currentNickname: doc.nickname || '',
      likeCount: doc.likesCount || 0,
      hasLiked: !!hasLiked,

      // 抽到新题时重置用户选择
      guessLat: null,
      guessLng: null,
      guessLocationName: '',
    };

    this.setData({
      ...payload,
      showResultPanel: false,
    });

    // 写入本地缓存：用于用户退出后再进仍是同一题
    try {
      wx.setStorageSync(CURRENT_Q_KEY, payload);
    } catch (e) {
      console.warn('保存当前题目到本地失败：', e);
    }
  },

  // 退出后再进入：尝试从本地恢复题目（仅限当天）
  _restoreQuestionFromStorage(todayStr) {
    try {
      const saved = wx.getStorageSync(CURRENT_Q_KEY) || null;
      if (!saved) return false;
      if (saved.todayStr !== todayStr) return false;
      if (!saved.currentPhotoId || !saved.imageUrl) return false;

      this.setData({
        imageUrl: saved.imageUrl,
        targetLat: saved.targetLat,
        targetLng: saved.targetLng,
        currentPhotoId: saved.currentPhotoId,
        currentLocationName: saved.currentLocationName || '',
        currentMessage: saved.currentMessage || '',
        currentNickname: saved.currentNickname || '',
        likeCount: saved.likeCount || 0,
        hasLiked: !!saved.hasLiked,
        // 若你希望恢复用户上次点的地点，也可以用下面三行
        guessLat: saved.guessLat == null ? null : saved.guessLat,
        guessLng: saved.guessLng == null ? null : saved.guessLng,
        guessLocationName: saved.guessLocationName || '',
        showResultPanel: false,
      });

      console.log('[guess] 当前题目从本地恢复成功');
      return true;
    } catch (e) {
      console.error('恢复当前题目失败：', e);
      return false;
    }
  },

  // 按指定 photoId 加载题目（这里不强制 isFeatured，方便以后手动跳转）
  _loadFromPublishById(photoId) {
    wx.showLoading({ title: '加载中', mask: true });
    db.collection(COLLECTION_PUBLISH)
      .doc(photoId)
      .get()
      .then((res) => {
        const doc = res.data || {};
        if (!doc.originFileID || doc.latitude == null || doc.longitude == null) {
          wx.showToast({ title: '该图片缺少位置信息', icon: 'none' });
          return;
        }
        this._applyDocAsQuestion(doc);
      })
      .catch((err) => {
        console.error('加载指定图片失败：', err);
        wx.showToast({ title: '加载失败', icon: 'none' });
      })
      .finally(() => {
        wx.hideLoading();
      });
  },

  // 随机抽一张 APPROVED + isFeatured=true 且有经纬度 + 大图 的图片
  async _loadRandomFromPublish() {
    wx.showLoading({ title: '抽题中', mask: true });
    try {
      const baseWhere = {
        status: 'APPROVED',
        // ✅ 兼容多种“精选”写法：布尔 true / 字符串 'true' / 数字 1
        isFeatured: _.in([true, 'true', 1]),
        originFileID: _.exists(true),
        latitude: _.neq(null),
        longitude: _.neq(null),
      };

      // 调试用：可以看看实际总数
      const countRes = await db.collection(COLLECTION_PUBLISH)
        .where(baseWhere)
        .count();

      const total = countRes.total || 0;
      console.log('[guess] featured total =', total);

      if (!total) {
        wx.showToast({ title: '暂无精选题目', icon: 'none' });
        return;
      }

      const randomIndex = Math.floor(Math.random() * total);

      const listRes = await db.collection(COLLECTION_PUBLISH)
        .where(baseWhere)
        .skip(randomIndex)
        .limit(1)
        .get();

      const doc = (listRes.data && listRes.data[0]) || null;
      if (!doc) {
        wx.showToast({ title: '抽题失败', icon: 'none' });
        return;
      }

      this._applyDocAsQuestion(doc);
    } catch (e) {
      console.error('随机抽题失败：', e);
      wx.showToast({ title: '抽题失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // 进入下一张（当前逻辑：随机抽一张）
  _goNextQuestion() {
    if (this.data.remaining <= 0) {
      wx.showToast({ title: '次数已用完', icon: 'none' });
      this._promptAdIfNoChance();
      return;
    }
    this._loadRandomFromPublish();
  },

  /* ========== 业务逻辑：每日次数 ========== */

  _getTodayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${y}-${pad(m)}-${pad(day)}`;
  },

  _loadTodayState(today) {
    const saved = wx.getStorageSync(STORAGE_KEY) || {};
    const state = saved[today] || {
      used: 0,      // 使用次数
      bonus: 0,     // 猜对奖励 + 看广告累计次数
    };

    const remaining = DAILY_FREE_TIMES + state.bonus - state.used;
    this.setData({
      remaining: Math.max(0, remaining),
      canSubmit: remaining > 0,
    });

    this._state = state;
    this._savedAll = saved;
  },

  _saveTodayState() {
    const today = this.data._todayStr || this._getTodayStr();
    const all = this._savedAll || {};
    all[today] = this._state;
    wx.setStorageSync(STORAGE_KEY, all);

    const remaining = DAILY_FREE_TIMES + this._state.bonus - this._state.used;
    this.setData({
      remaining: Math.max(0, remaining),
      canSubmit: remaining > 0,
    });
  },

  /* ========== 本周战绩（周一清零） ========== */

  // 获取当前周一日期（YYYY-MM-DD）
  _getWeekStartStr() {
    const d = new Date();
    const day = d.getDay(); // 0=周日,1=周一,...6=周六
    const diff = (day + 6) % 7; // 距离周一要回退几天
    d.setDate(d.getDate() - diff);

    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const md = d.getDate();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${y}-${pad(m)}-${pad(md)}`;
  },

  // ✅ 新增：自动清理上一周及更早的 guess_stats 数据
  async _cleanupOldStats() {
    const weekStart = this._weekStartStr;
    if (!weekStart) return;

    try {
      // 删除所有 weekStart 小于本周一的历史记录
      const res = await db.collection(COLLECTION_GUESS_STATS)
        .where({
          weekStart: _.lt(weekStart),
        })
        .remove();

      console.log('[guess] 清理历史周统计完成:', res);
    } catch (e) {
      console.error('清理历史周统计失败：', e);
    }
  },

  // 初始化本周统计：读取用户 openid，然后拉本周猜对次数与排名
  _initWeeklyStats() {
    const user = wx.getStorageSync('user') || {};
    const openid = user.openid || user.openId || '';
    const nickname = user.nickname || user.nickName || '';

    if (!openid) {
      console.warn('未登录，无法统计周排名');
      return;
    }

    this._openid = openid;
    this._nickname = nickname; // 之后写入 guess_stats 用

    // 🔥 每周进入页面时，顺便清掉老数据
    this._cleanupOldStats();

    this._loadWeeklyCorrectAndRank();
  },

  // 从 guess_stats 集合读取用户本周猜对次数，并计算排名 + 距离上一名 + 前 5 名
  async _loadWeeklyCorrectAndRank() {
    const openid = this._openid;
    const weekStart = this._weekStartStr;
    if (!openid || !weekStart) return;

    try {
      // 1) 当前用户本周记录
      const selfRes = await db.collection(COLLECTION_GUESS_STATS)
        .where({
          openid,
          weekStart,
        })
        .limit(1)
        .get();

      let correct = 0;

      if (selfRes.data && selfRes.data.length > 0) {
        correct = selfRes.data[0].correctCount || 0;
      }

      // 默认：无记录时，排名/差距都为 '--'
      let rank = '--';
      let weeklyDiff = '--';

      // 2) 计算排名：拿本周前 100
      const topRes = await db.collection(COLLECTION_GUESS_STATS)
        .where({
          weekStart,
        })
        .orderBy('correctCount', 'desc')
        .orderBy('updatedAt', 'asc')
        .limit(100)
        .get();

      const list = topRes.data || [];

      // 本周前 5 名（显示昵称）
      let weeklyTopList = [];
      if (list.length > 0) {
        weeklyTopList = list.slice(0, 5).map((item, index) => ({
          rank: index + 1,
          displayName: item.nickname || '玩家',
          correctCount: item.correctCount || 0,
        }));
      }

      if (correct > 0 && list.length > 0) {
        for (let i = 0; i < list.length; i++) {
          if (list[i].openid === openid) {
            rank = i + 1;
            if (i === 0) {
              // 第一名：距离上一名为 0
              weeklyDiff = 0;
            } else {
              const prev = list[i - 1];
              const prevCorrect = prev.correctCount || 0;
              let diff = prevCorrect - correct;
              if (diff < 0) diff = 0;
              weeklyDiff = diff;
            }
            break;
          }
        }

        // 在榜单外但有成绩：排名记为 100+，差距保持 '--'
        if (rank === '--') {
          rank = '100+';
          weeklyDiff = '--';
        }
      }

      this.setData({
        weeklyCorrect: correct,
        weeklyRank: rank,
        weeklyDiff,
        weeklyTopList,
      });
    } catch (e) {
      console.error('加载周统计失败：', e);
      this.setData({
        weeklyTopList: [],
      });
    }
  },

  // 猜对一次后，更新 guess_stats 集合
  async _updateWeeklyStatsOnWin() {
    const openid = this._openid;
    const weekStart = this._weekStartStr;
    const nickname = this._nickname || '';

    if (!openid || !weekStart) {
      // 没登录就不统计
      return;
    }

    try {
      const coll = db.collection(COLLECTION_GUESS_STATS);
      const res = await coll.where({ openid, weekStart }).limit(1).get();

      if (!res.data || res.data.length === 0) {
        // 新建本周记录
        await coll.add({
          data: {
            openid,
            weekStart,
            correctCount: 1,
            updatedAt: new Date(),
            nickname, // 写入昵称
          },
        });
        this.setData({
          weeklyCorrect: 1,
        });
      } else {
        // 在现有记录上 +1，并顺便更新昵称（防止昵称改了）
        const doc = res.data[0];
        await coll.doc(doc._id).update({
          data: {
            correctCount: _.inc(1),
            updatedAt: new Date(),
            nickname,
          },
        });
        this.setData({
          weeklyCorrect: (doc.correctCount || 0) + 1,
        });
      }

      // 更新次数后重新算排名 + 差距 + 前五
      this._loadWeeklyCorrectAndRank();
    } catch (e) {
      console.error('更新周统计失败：', e);
    }
  },

  /* ========== 激励视频广告 ========== */

  // 用户点击“看广告再猜一次”
  onWatchAd() {
    if (!videoAd) {
      wx.showToast({ title: '广告不可用', icon: 'none' });
      return;
    }

    videoAd.show().catch(() => {
      // 失败重试
      videoAd.load()
        .then(() => videoAd.show())
        .catch(err => {
          console.error('激励视频广告显示失败', err);
          wx.showToast({ title: '广告暂时不可用', icon: 'none' });
        });
    });
  },

  // 看完广告奖励一次机会
  _onAdReward() {
    this._state.bonus += 1;
    this._saveTodayState();
    wx.showToast({
      title: '已奖励 1 次机会',
      icon: 'success',
    });
  },

  // 次数用完后自动询问是否看广告
  _promptAdIfNoChance() {
    if (this.data.remaining > 0) return; // 还有次数就不弹
    if (!videoAd) {
      wx.showToast({ title: '广告不可用', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '次数用完啦',
      content: '观看一段视频广告可获得 1 次机会，要看吗？',
      confirmText: '看广告',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this.onWatchAd();
        }
      }
    });
  },

  /* ========== 地址选择 ========== */

  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          guessLat: res.latitude,
          guessLng: res.longitude,
          guessLocationName: res.name || res.address || '未命名地点',
        });

        // 如需连用户选择也持久化，可顺便更新本地缓存
        try {
          const saved = wx.getStorageSync(CURRENT_Q_KEY) || {};
          if (saved && saved.currentPhotoId === this.data.currentPhotoId) {
            wx.setStorageSync(CURRENT_Q_KEY, {
              ...saved,
              guessLat: res.latitude,
              guessLng: res.longitude,
              guessLocationName: res.name || res.address || '未命名地点',
            });
          }
        } catch (e) {
          console.warn('更新本地题目缓存（猜测位置）失败：', e);
        }
      },
      fail: (err) => {
        console.error('chooseLocation fail:', err);
      },
    });
  },

  /* ========== 放弃本题 ========== */

  onGiveUp() {
    if (!this.data.canSubmit) {
      wx.showToast({
        title: '今日次数已用完',
        icon: 'none',
      });
      this._promptAdIfNoChance();
      return;
    }

    wx.showModal({
      title: '确认放弃本题？',
      content: '放弃会消耗 1 次机会，且本题不算正确，确定要放弃吗？',
      confirmText: '放弃',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return;

        // 消耗一次机会（不奖励，不计入周统计）
        this._state.used += 1;
        this._saveTodayState();

        wx.showToast({
          title: '本题已放弃',
          icon: 'none',
        });

        // 打开结果弹窗：显示地点、留言、点赞
        this.setData({
          showResultPanel: true,
        });
        // 是否提示看广告，等用户关闭弹窗或点下一张时再说
      }
    });
  },

  /* ========== 提交猜测 ========== */

  onSubmit() {
    if (!this.data.canSubmit) {
      wx.showToast({
        title: '今日次数已用完',
        icon: 'none',
      });
      this._promptAdIfNoChance();
      return;
    }
    if (this.data.guessLat == null || this.data.guessLng == null) {
      wx.showToast({
        title: '请先选择地点',
        icon: 'none',
      });
      return;
    }

    const { targetLat, targetLng, guessLat, guessLng } = this.data;
    if (targetLat == null || targetLng == null) {
      wx.showToast({
        title: '当前题目暂无正确坐标',
        icon: 'none',
      });
      return;
    }

    // 使用一次机会
    this._state.used += 1;

    const dist = this._calcDistance(targetLat, targetLng, guessLat, guessLng);
    const isWin = dist <= WIN_DISTANCE_M;
    const km = Math.round(dist / 1000);

    if (isWin) {
      // 猜对奖励 1 次：相当于本次不扣，还额外 +1
      this._state.bonus += 1;
      this._updateWeeklyStatsOnWin();
    }

    this._saveTodayState();

    if (isWin) {
      // 简单提示一下距离
      wx.showToast({
        title: `约 ${km} km，猜对啦！`,
        icon: 'none',
      });

      // 打开结果弹窗：显示地点 + 留言 + 点赞
      this.setData({
        showResultPanel: true,
      });
      // 是否看广告，等关闭弹窗/下一张再说
    } else {
      const content =
        `距离正确地点约 ${km} km\n` +
        `要重试一次，还是下一张？`;

      wx.showModal({
        title: '差一点点…',
        content,
        showCancel: true,
        confirmText: '重试',
        cancelText: '下一张',
        success: (res) => {
          if (!res.confirm) {
            // 选择“下一张”
            this._goNextQuestion();
          }
          // 无论重试还是下一张，出来以后如果没次数了就问广告
          this._promptAdIfNoChance();
        },
      });
    }
  },

  /* ========== 结果弹窗：关闭 / 下一张 ========== */

  onCloseResult() {
    this.setData({
      showResultPanel: false,
    });
    this._promptAdIfNoChance();
  },

  onNextFromResult() {
    this.setData({
      showResultPanel: false,
    });
    this._goNextQuestion();
  },

  /* ========== 点赞 ========== */

  _ensureOpenid() {
    if (this._openid) return this._openid;
    const user = wx.getStorageSync('user') || {};
    const openid = user.openid || user.openId || '';
    this._openid = openid;
    return openid;
  },

  onToggleLike() {
    const photoId = this.data.currentPhotoId;
    if (!photoId) return;

    const openid = this._ensureOpenid();
    if (!openid) {
      wx.showToast({ title: '请先登录再点赞', icon: 'none' });
      return;
    }

    if (this._liking) return;
    this._liking = true;

    // 本地点赞乐观更新
    const prevLiked = this.data.hasLiked;
    const prevCount = this.data.likeCount;
    const nextLiked = !prevLiked;
    const nextCount = prevCount + (nextLiked ? 1 : -1);

    this.setData({
      hasLiked: nextLiked,
      likeCount: nextCount < 0 ? 0 : nextCount,
    });

    // 顺便把点赞状态更新进本地缓存（让返回后题目和点赞一致）
    try {
      const saved = wx.getStorageSync(CURRENT_Q_KEY) || {};
      if (saved && saved.currentPhotoId === photoId) {
        wx.setStorageSync(CURRENT_Q_KEY, {
          ...saved,
          hasLiked: nextLiked,
          likeCount: nextCount < 0 ? 0 : nextCount,
        });
      }
    } catch (e) {
      console.warn('更新本地题目缓存（点赞）失败：', e);
    }

    wx.cloud.callFunction({
      name: 'toggleLike',
      data: { photoId },
    }).then(() => {
      // 成功就算了，不强制和后端再对齐
    }).catch(err => {
      console.error('toggleLike 调用失败：', err);
      // 回滚
      this.setData({
        hasLiked: prevLiked,
        likeCount: prevCount,
      });

      // 回滚本地缓存
      try {
        const saved = wx.getStorageSync(CURRENT_Q_KEY) || {};
        if (saved && saved.currentPhotoId === photoId) {
          wx.setStorageSync(CURRENT_Q_KEY, {
            ...saved,
            hasLiked: prevLiked,
            likeCount: prevCount,
          });
        }
      } catch (e) {
        console.warn('回滚本地题目缓存（点赞）失败：', e);
      }

      wx.showToast({ title: '点赞失败', icon: 'none' });
    }).finally(() => {
      this._liking = false;
    });
  },

  /* ========== 工具：计算距离 ========== */

  // 计算两点间距离（米）—— 简单 Haversine
  _calcDistance(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371000; // 地球半径（米）
    const dLat = toRad(lat2 - lat1);
    const dLngReal = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLngReal / 2) *
        Math.sin(dLngReal / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  /* ========== 其它 ========== */

  onPreviewImage() {
    const url = this.data.imageUrl;
    if (!url) return;
    wx.previewImage({
      urls: [url],
    });
  },

  onBackTap() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({
        url: '/pages/index/index',
      });
    }
  },
});
