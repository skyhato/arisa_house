const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

const USERS = 'users'
const PUBLISH = 'publish'
const ADMINS = 'admins'

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

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const {
    page = 0,
    pageSize = 100,
    sortMode = 'time',  // 'time' | 'works'
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
    return { ok: false, msg: 'no permission', items: [], hasMore: false }
  }

  const size = Math.min(Math.max(1, Number(pageSize) || 100), 100)
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
        return { ok: true, items: [], hasMore: false, sortMode: 'works' }
      }
    }

    // 3.2 从 publish 聚合：作品数 + 从作品里捞一个昵称兜底
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
        nicknameFromPublish: $.max('$nickname') // 兜底昵称
      })
      .sort({ worksCount: -1 })
      .skip(skip)
      .limit(size)
      .end()

    const groups = pageAgg.list || []
    const openids = groups.map(g => String(g._id)).filter(Boolean)

    // 3.3 判定 hasMore：探一条下一页
    let hasMore = false
    if (groups.length === size) {
      let probe = db.collection(PUBLISH).aggregate()
      if (allowedOpenids) {
        probe = probe.match({
          openid: _.in(allowedOpenids)
        })
      }
      const probeRes = await probe
        .group({
          _id: '$openid',
          worksCount: $.sum(1)
        })
        .sort({ worksCount: -1 })
        .skip(skip + size)
        .limit(1)
        .end()
      hasMore = !!(probeRes.list && probeRes.list.length)
    }

    // 3.4 拉 users 资料，允许一个 openid 对应多条，优先选“有昵称”的那条
    const usersMap = {}
    const CHUNK = 100
    for (let i = 0; i < openids.length; i += CHUNK) {
      const sub = openids.slice(i, i + CHUNK)
      const uRes = await db
        .collection(USERS)
        .where({
          openid: _.in(sub)
        })
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
          // 优先选择有昵称的；若旧的没昵称而新的有，就覆盖
          if (!oldHasName && newHasName) {
            usersMap[k] = u
          }
        }
      })
    }

    // 3.5 组装 items（优先 users.nickname，其次作品里的 nicknameFromPublish）
    const items = groups.map(g => {
      const openid = String(g._id)
      const u = usersMap[openid] || {}
      const createdAt = pickCreateTime(u)
      const nicknameFromUser = (u.nickname && String(u.nickname).trim()) || ''
      const nicknameFromPublish =
        (g.nicknameFromPublish && String(g.nicknameFromPublish).trim()) || ''
      const nickname = nicknameFromUser || nicknameFromPublish || ''

      return {
        _id: u._id || openid,
        openid,
        nickname,                                   // ✅ 这里不会轻易变成空
        avatar: u.avatar || u.avatarUrl || '',
        createdAt,
        createTimeStr: ts2str(createdAt),
        worksCount: g.worksCount || 0
      }
    })

    return { ok: true, items, hasMore, sortMode: 'works' }
  }

  // ===== 4. 按注册时间排序 =====
  const orderField = 'createdAt' // 用这个字段建索引效果最好

  const baseQuery = db.collection(USERS).where(userWhere || {})

  const [uRes, totalRes] = await Promise.all([
    baseQuery
      .orderBy(orderField, 'desc')
      .skip(skip)
      .limit(size)
      .get(),
    baseQuery.count()
  ])

  const list = (uRes.data || []).map(u => {
    const openid = String(u.openid || u._openid || '')
    const createdAt = pickCreateTime(u)
    const nickname = (u.nickname && String(u.nickname).trim()) || ''
    return {
      _id: u._id || openid,
      openid,
      nickname,                                   // ✅ 先用 users.nickname
      avatar: u.avatar || u.avatarUrl || '',
      createdAt,
      createTimeStr: ts2str(createdAt),
      worksCount: 0
    }
  })

  // 4.1 当前页 openid 列表
  const pageOpenids = list.map(x => x.openid).filter(Boolean)

  if (pageOpenids.length) {
    // 4.2 一次聚合：作品数 + 作品里的 nickname，用来兜底
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

    // 4.3 给当前页补 worksCount + 兜底昵称
    list.forEach(x => {
      const info = infoMap[x.openid]
      if (!info) return
      x.worksCount = info.worksCount || 0
      if (!x.nickname && info.nicknameFromPublish) {
        x.nickname = info.nicknameFromPublish
      }
    })
  }

  const total = totalRes.total || 0
  const hasMore = skip + list.length < total

  return { ok: true, items: list, hasMore, total, sortMode: 'time' }
}
