/**
 * 云函数：adminListUsers
 *
 * 作用：
 * 1. 管理员分页查看用户列表
 * 2. 支持按注册时间 / 作品数排序
 * 3. 支持按昵称 / openid 搜索
 * 4. 返回 uid、昵称、头像、作品数、注册时间等信息
 *
 * 本次优化：
 * 1. users 查询增加 field，只取必要字段
 * 2. 前端单页建议 40 条，这里同样限制为 40
 * 3. 按注册时间排序时，使用 limit(size + 1) 判断 hasMore
 * 4. total 仅在第一页统计，后续翻页不再重复 count
 * 5. 按作品数排序时，去掉额外 probe 查询，改为多取 1 条判断 hasMore
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

const USERS = 'users'
const PUBLISH = 'publish'
const ADMINS = 'admins'
const PAGE_LIMIT = 40

function pickCreateTime(u) {
  return (
    u.createdAt ||
    u.createAt ||
    u.createTime ||
    u._createTime ||
    u._create_time ||
    null
  )
}

function ts2str(t) {
  try {
    if (!t) return '未知'
    let ms
    if (t instanceof Date) ms = t.getTime()
    else if (typeof t === 'number') ms = t
    else ms = new Date(t).getTime()

    if (!ms || isNaN(ms)) return '未知'

    const d = new Date(ms)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  } catch {
    return '未知'
  }
}

function userField() {
  return {
    _id: true,
    uid: true,
    openid: true,
    _openid: true,
    nickname: true,
    avatar: true,
    avatarUrl: true,
    createdAt: true,
    createAt: true,
    createTime: true,
    _createTime: true,
    _create_time: true
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const {
    page = 0,
    pageSize = PAGE_LIMIT,
    sortMode = 'time', // 'time' | 'works'
    searchKey = ''
  } = event || {}

  // ===== 1. 管理员校验 =====
  const adminRes = await db
    .collection(ADMINS)
    .where({ openid: String(OPENID), enabled: true })
    .limit(1)
    .get()

  const isAdmin = !!(adminRes.data && adminRes.data.length)
  if (!isAdmin) {
    return { ok: false, msg: 'no permission', items: [], hasMore: false, total: 0 }
  }

  const size = Math.min(Math.max(1, Number(pageSize) || PAGE_LIMIT), PAGE_LIMIT)
  const curPage = Math.max(0, Number(page) || 0)
  const skip = curPage * size

  // ===== 2. 搜索条件 =====
  let userWhere = {}
  const key = String(searchKey || '').trim()

  if (key) {
    const reg = db.RegExp({ regexp: key, options: 'i' })
    userWhere = _.or(
      { nickname: reg },
      { openid: reg }
    )
  }

  // ===== 3. 按作品数排序 =====
  if (sortMode === 'works') {
    // 3.1 若有搜索，先在 users 中筛出 allowedOpenids
    let allowedOpenids = null
    if (key) {
      const BATCH = 500
      allowedOpenids = []
      let uSkip = 0

      for (;;) {
        const uRes = await db
          .collection(USERS)
          .where(userWhere)
          .field({
            openid: true,
            _openid: true
          })
          .skip(uSkip)
          .limit(BATCH)
          .get()

        const arr = (uRes.data || [])
          .map(u => String(u.openid || u._openid || ''))
          .filter(Boolean)

        allowedOpenids.push(...arr)

        if (arr.length < BATCH) break
        uSkip += BATCH
        if (allowedOpenids.length >= 10000) break
      }

      if (!allowedOpenids.length) {
        return {
          ok: true,
          items: [],
          hasMore: false,
          total: 0,
          sortMode: 'works'
        }
      }
    }

    // 3.2 从 publish 聚合：作品数 + 作品昵称兜底
    let pipeline = db.collection(PUBLISH).aggregate()
    if (allowedOpenids) {
      pipeline = pipeline.match({
        openid: _.in(allowedOpenids)
      })
    }

    const pageAgg = await pipeline
      .group({
        _id: '$openid',
        worksCount: $.sum(1),
        nicknameFromPublish: $.max('$nickname')
      })
      .sort({ worksCount: -1 })
      .skip(skip)
      .limit(size + 1)
      .end()

    const groupsRaw = pageAgg.list || []
    const hasMore = groupsRaw.length > size
    const groups = hasMore ? groupsRaw.slice(0, size) : groupsRaw
    const openids = groups.map(g => String(g._id)).filter(Boolean)

    // 3.3 拉 users 资料
    const usersMap = {}
    const CHUNK = 100

    for (let i = 0; i < openids.length; i += CHUNK) {
      const sub = openids.slice(i, i + CHUNK)
      const uRes = await db
        .collection(USERS)
        .where({
          openid: _.in(sub)
        })
        .field(userField())
        .get()

      ;(uRes.data || []).forEach(u => {
        const k = String(u.openid || u._openid || '')
        if (!k) return

        const existing = usersMap[k]
        if (!existing) {
          usersMap[k] = u
        } else {
          const oldHasName = !!(existing.nickname && String(existing.nickname).trim())
          const newHasName = !!(u.nickname && String(u.nickname).trim())
          if (!oldHasName && newHasName) {
            usersMap[k] = u
          }
        }
      })
    }

    // 3.4 组装 items
    const items = groups.map(g => {
      const openid = String(g._id)
      const u = usersMap[openid] || {}
      const createdAt = pickCreateTime(u)
      const nicknameFromUser = (u.nickname && String(u.nickname).trim()) || ''
      const nicknameFromPublish = (g.nicknameFromPublish && String(g.nicknameFromPublish).trim()) || ''
      const nickname = nicknameFromUser || nicknameFromPublish || ''

      return {
        _id: u._id || openid,
        uid: u.uid,
        openid,
        nickname,
        avatar: u.avatar || u.avatarUrl || '',
        createdAt,
        createTimeStr: ts2str(createdAt),
        worksCount: g.worksCount || 0
      }
    })

    return {
      ok: true,
      items,
      hasMore,
      // works 模式下不强制更新 total，前端会沿用已有值
      total: undefined,
      sortMode: 'works'
    }
  }

  // ===== 4. 按注册时间排序 =====
  const orderField = 'createdAt'
  const baseQuery = db.collection(USERS).where(userWhere || {})

  const queryPromise = baseQuery
    .field(userField())
    .orderBy(orderField, 'desc')
    .skip(skip)
    .limit(size + 1)
    .get()

  // 只在第一页查 total，后续翻页不再 count
  const totalPromise = curPage === 0
    ? baseQuery.count()
    : Promise.resolve({ total: undefined })

  const [uRes, totalRes] = await Promise.all([queryPromise, totalPromise])

  const rawList = uRes.data || []
  const hasMore = rawList.length > size
  const pageList = hasMore ? rawList.slice(0, size) : rawList

  const list = pageList.map(u => {
    const openid = String(u.openid || u._openid || '')
    const createdAt = pickCreateTime(u)
    const nickname = (u.nickname && String(u.nickname).trim()) || ''

    return {
      _id: u._id || openid,
      uid: u.uid,
      openid,
      nickname,
      avatar: u.avatar || u.avatarUrl || '',
      createdAt,
      createTimeStr: ts2str(createdAt),
      worksCount: 0
    }
  })

  // 4.1 当前页 openid 列表
  const pageOpenids = list.map(x => x.openid).filter(Boolean)

  if (pageOpenids.length) {
    // 4.2 当前页聚合作品数
    const agg = await db
      .collection(PUBLISH)
      .aggregate()
      .match({ openid: _.in(pageOpenids) })
      .group({
        _id: '$openid',
        worksCount: $.sum(1),
        nicknameFromPublish: $.max('$nickname')
      })
      .end()

    const infoMap = {}
    ;(agg.list || []).forEach(r => {
      infoMap[String(r._id)] = {
        worksCount: r.worksCount || 0,
        nicknameFromPublish:
          (r.nicknameFromPublish && String(r.nicknameFromPublish).trim()) || ''
      }
    })

    list.forEach(x => {
      const info = infoMap[x.openid]
      if (!info) return
      x.worksCount = info.worksCount || 0
      if (!x.nickname && info.nicknameFromPublish) {
        x.nickname = info.nicknameFromPublish
      }
    })
  }

  return {
    ok: true,
    items: list,
    hasMore,
    total: totalRes.total,
    sortMode: 'time'
  }
}