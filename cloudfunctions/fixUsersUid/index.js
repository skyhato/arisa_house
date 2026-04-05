/**
 * 微信云开发 users 集合一次性清洗脚本
 *
 * 作用：
 * 1. 按 openid / _openid 去重，只保留每个用户 1 条正式记录
 * 2. 给保留记录补 uid（按 createdAt、updatedAt、_id 排序后从 1 开始）
 * 3. 删除重复的“简化记录”（常见特征：_id === openid）
 * 4. 删除保留记录里的冗余字段：_openid、unionid、appid（可配置）
 *
 * 适用前提：
 * - 当前集合名默认是 users
 * - 你的用户主身份字段是 openid（若没有则回退 _openid）
 * - 同一个 openid 可能存在一条完整记录 + 一条简化记录
 *
 * 使用步骤：
 * 1. 先备份 users 集合
 * 2. 先把 DRY_RUN 改成 true 试跑，看日志和返回结果
 * 3. 确认无误后，再把 DRY_RUN 改成 false 正式执行
 *
 * 注意：
 * - 微信云开发里的 _id 是系统字段，不能从保留文档里删除
 * - 本脚本会真的删除重复文档，执行前务必备份
 * - 如果你未来要做多 app 用户体系，建议把 REMOVE_APPID 改成 false
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// ===== 可配置项 =====
const COLLECTION_NAME = 'users'
const PAGE_SIZE = 100
const DRY_RUN = false
const REMOVE_APPID = true
const REMOVE_EMPTY_UNIONID = true
const UID_START = 1
const WRITE_CHUNK_SIZE = 20

// ===== 工具函数 =====
function getOpenid(doc) {
  return doc.openid || doc._openid || ''
}

function isNonEmpty(value) {
  return value !== undefined && value !== null && value !== ''
}

function getTime(value) {
  if (!value) return 0
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const t = new Date(value).getTime()
    return Number.isNaN(t) ? 0 : t
  }
  if (typeof value === 'object' && value.$date) {
    const t = new Date(value.$date).getTime()
    return Number.isNaN(t) ? 0 : t
  }
  return 0
}

function fieldCount(doc) {
  return Object.keys(doc || {}).filter((key) => isNonEmpty(doc[key])).length
}

function isSimplifiedDoc(doc) {
  const openid = getOpenid(doc)
  return !!openid && doc._id === openid
}

function compareKeepPriority(a, b) {
  // 返回负数表示 a 更优先

  // 1. 优先保留不是“_id === openid”的正式记录
  const aSimple = isSimplifiedDoc(a) ? 1 : 0
  const bSimple = isSimplifiedDoc(b) ? 1 : 0
  if (aSimple !== bSimple) return aSimple - bSimple

  // 2. 字段更多的优先
  const aFieldCount = fieldCount(a)
  const bFieldCount = fieldCount(b)
  if (aFieldCount !== bFieldCount) return bFieldCount - aFieldCount

  // 3. updatedAt 更新更晚的优先
  const aUpdated = getTime(a.updatedAt)
  const bUpdated = getTime(b.updatedAt)
  if (aUpdated !== bUpdated) return bUpdated - aUpdated

  // 4. createdAt 更早的优先（更像主记录）
  const aCreated = getTime(a.createdAt)
  const bCreated = getTime(b.createdAt)
  if (aCreated !== bCreated) return aCreated - bCreated

  // 5. 最后按 _id 稳定排序
  return String(a._id).localeCompare(String(b._id))
}

function pickLatestNonEmpty(docs, fieldName) {
  const candidates = docs
    .filter((doc) => isNonEmpty(doc[fieldName]))
    .sort((a, b) => getTime(b.updatedAt) - getTime(a.updatedAt))

  return candidates.length ? candidates[0][fieldName] : undefined
}

function pickLatestTimeValue(docs, fieldName) {
  const candidates = docs
    .filter((doc) => isNonEmpty(doc[fieldName]))
    .sort((a, b) => getTime(b[fieldName]) - getTime(a[fieldName]))

  return candidates.length ? candidates[0][fieldName] : undefined
}

function pickMinNumber(docs, fieldName) {
  const nums = docs
    .map((doc) => doc[fieldName])
    .filter((v) => typeof v === 'number' && !Number.isNaN(v))

  return nums.length ? Math.min(...nums) : undefined
}

function pickMaxNumber(docs, fieldName) {
  const nums = docs
    .map((doc) => doc[fieldName])
    .filter((v) => typeof v === 'number' && !Number.isNaN(v))

  return nums.length ? Math.max(...nums) : undefined
}

function chunkArray(arr, size) {
  const result = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}

async function fetchAllDocs(collectionName) {
  const totalRes = await db.collection(collectionName).count()
  const total = totalRes.total
  const allDocs = []

  for (let skip = 0; skip < total; skip += PAGE_SIZE) {
    const res = await db.collection(collectionName).skip(skip).limit(PAGE_SIZE).get()
    allDocs.push(...res.data)
  }

  return allDocs
}

function buildMergedDoc(keepDoc, sameUserDocs) {
  const merged = {
    uid: keepDoc.uid,
    openid: getOpenid(keepDoc),
    nickname: pickLatestNonEmpty(sameUserDocs, 'nickname') || '',
    avatar: pickLatestNonEmpty(sameUserDocs, 'avatar') || '',
    role: pickLatestNonEmpty(sameUserDocs, 'role') || 'user',
    createdAt: pickMinNumber(sameUserDocs, 'createdAt') ?? keepDoc.createdAt ?? Date.now(),
    updatedAt: pickMaxNumber(sameUserDocs, 'updatedAt') ?? keepDoc.updatedAt ?? Date.now(),
  }

  const lastLoginAt = pickLatestTimeValue(sameUserDocs, 'lastLoginAt')
  if (lastLoginAt !== undefined) {
    merged.lastLoginAt = lastLoginAt
  }

  const unionid = pickLatestNonEmpty(sameUserDocs, 'unionid')
  if (!REMOVE_EMPTY_UNIONID && unionid !== undefined) {
    merged.unionid = unionid
  } else if (REMOVE_EMPTY_UNIONID && isNonEmpty(unionid)) {
    merged.unionid = unionid
  }

  const appid = pickLatestNonEmpty(sameUserDocs, 'appid')
  if (!REMOVE_APPID && appid !== undefined) {
    merged.appid = appid
  }

  return merged
}

async function updateDocsInChunks(collectionName, tasks) {
  const chunks = chunkArray(tasks, WRITE_CHUNK_SIZE)
  for (const chunk of chunks) {
    await Promise.all(
      chunk.map((task) =>
        db.collection(collectionName).doc(task.docId).update({ data: task.data })
      )
    )
  }
}

async function removeDocsInChunks(collectionName, docIds) {
  const chunks = chunkArray(docIds, WRITE_CHUNK_SIZE)
  for (const chunk of chunks) {
    await Promise.all(
      chunk.map((docId) => db.collection(collectionName).doc(docId).remove())
    )
  }
}

exports.main = async () => {
  const allDocs = await fetchAllDocs(COLLECTION_NAME)

  const groups = new Map()
  const invalidDocIds = []

  for (const doc of allDocs) {
    const openid = getOpenid(doc)
    if (!openid) {
      invalidDocIds.push(doc._id)
      continue
    }

    if (!groups.has(openid)) {
      groups.set(openid, [])
    }
    groups.get(openid).push(doc)
  }

  const users = []
  const duplicateDeleteIds = []
  const duplicateGroupPreview = []

  for (const [openid, docs] of groups.entries()) {
    const sortedDocs = [...docs].sort(compareKeepPriority)
    const keepDoc = sortedDocs[0]
    const deleteDocs = sortedDocs.slice(1)

    users.push({ openid, keepDoc, docs: sortedDocs })

    if (deleteDocs.length > 0) {
      duplicateGroupPreview.push({
        openid,
        keepId: keepDoc._id,
        deleteIds: deleteDocs.map((d) => d._id),
      })
      duplicateDeleteIds.push(...deleteDocs.map((d) => d._id))
    }
  }

  // uid 稳定排序：按 createdAt -> updatedAt -> _id
  users.sort((a, b) => {
    const aCreated = getTime(a.keepDoc.createdAt)
    const bCreated = getTime(b.keepDoc.createdAt)
    if (aCreated !== bCreated) return aCreated - bCreated

    const aUpdated = getTime(a.keepDoc.updatedAt)
    const bUpdated = getTime(b.keepDoc.updatedAt)
    if (aUpdated !== bUpdated) return aUpdated - bUpdated

    return String(a.keepDoc._id).localeCompare(String(b.keepDoc._id))
  })

  const updateTasks = users.map((user, index) => {
    const uid = UID_START + index
    user.keepDoc.uid = uid

    const merged = buildMergedDoc(user.keepDoc, user.docs)
    return {
      docId: user.keepDoc._id,
      data: merged,
    }
  })

  const summary = {
    dryRun: DRY_RUN,
    collection: COLLECTION_NAME,
    totalDocsBefore: allDocs.length,
    validUsers: users.length,
    invalidDocsWithoutOpenid: invalidDocIds.length,
    duplicateDocsToDelete: duplicateDeleteIds.length,
    docsAfterCleanup: users.length,
    uidRange: users.length ? [UID_START, UID_START + users.length - 1] : [],
    removedFieldsFromKeptDocs: [
      '_openid',
      ...(REMOVE_EMPTY_UNIONID ? ['unionid(空值删除，非空保留)'] : []),
      ...(REMOVE_APPID ? ['appid'] : []),
    ],
    duplicatePreview: duplicateGroupPreview.slice(0, 20),
    invalidDocIdsPreview: invalidDocIds.slice(0, 20),
    updatePreview: updateTasks.slice(0, 5).map((item) => ({
      docId: item.docId,
      data: item.data,
    })),
  }

  console.log('用户清洗预览：', JSON.stringify(summary, null, 2))

  if (DRY_RUN) {
    return summary
  }

  if (invalidDocIds.length > 0) {
    await removeDocsInChunks(COLLECTION_NAME, invalidDocIds)
  }

  if (updateTasks.length > 0) {
    await updateDocsInChunks(COLLECTION_NAME, updateTasks)
  }

  if (duplicateDeleteIds.length > 0) {
    await removeDocsInChunks(COLLECTION_NAME, duplicateDeleteIds)
  }

  return {
    ...summary,
    executed: true,
  }
}