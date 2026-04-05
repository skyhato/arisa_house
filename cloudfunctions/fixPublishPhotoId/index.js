/**
 * 云函数：fixPublishPhotoId
 *
 * 作用：
 * 1. 给 publish 集合中的历史图片补业务编号 photoId
 * 2. 按 createdAt -> _id 排序，从 1 开始顺序编号
 * 3. 只补没有 photoId 的记录
 *
 * 不会做的事：
 * - 不删除任何字段
 * - 不删除任何图片文件
 * - 不修改其他业务字段
 *
 * 使用方式：
 * 1. 先把 DRY_RUN 设为 true 试跑
 * 2. 看返回结果和日志
 * 3. 确认没问题后，再改成 false 正式执行
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const COLLECTION_NAME = 'publish'
const PAGE_SIZE = 100
const WRITE_CHUNK_SIZE = 20
const DRY_RUN = false

function getTime(v) {
  if (!v) return 0
  if (typeof v === 'number') return v
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') {
    const t = new Date(v).getTime()
    return Number.isNaN(t) ? 0 : t
  }
  if (typeof v === 'object' && v.$date) {
    const t = new Date(v.$date).getTime()
    return Number.isNaN(t) ? 0 : t
  }
  return 0
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
    allDocs.push(...(res.data || []))
  }

  return allDocs
}

async function updateDocsInChunks(collectionName, tasks) {
  const chunks = chunkArray(tasks, WRITE_CHUNK_SIZE)

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(task =>
        db.collection(collectionName).doc(task.docId).update({
          data: task.data
        })
      )
    )
  }
}

exports.main = async () => {
  const allDocs = await fetchAllDocs(COLLECTION_NAME)

  // 按 createdAt -> _id 排序，保证编号稳定
  const sorted = [...allDocs].sort((a, b) => {
    const ta = getTime(a.createdAt)
    const tb = getTime(b.createdAt)
    if (ta !== tb) return ta - tb
    return String(a._id).localeCompare(String(b._id))
  })

  const alreadyHasPhotoId = sorted.filter(
    doc => doc.photoId !== undefined && doc.photoId !== null
  )

  const needFill = sorted.filter(
    doc => doc.photoId === undefined || doc.photoId === null
  )

  const existingMaxPhotoId = alreadyHasPhotoId.length
    ? Math.max(...alreadyHasPhotoId.map(doc => Number(doc.photoId) || 0))
    : 0

  const updateTasks = needFill.map((doc, index) => ({
    docId: doc._id,
    data: {
      photoId: existingMaxPhotoId + index + 1
    }
  }))

  const summary = {
    dryRun: DRY_RUN,
    collection: COLLECTION_NAME,
    totalDocsBefore: allDocs.length,
    alreadyHasPhotoId: alreadyHasPhotoId.length,
    needFillCount: needFill.length,
    photoIdRangeToWrite: updateTasks.length
      ? [existingMaxPhotoId + 1, existingMaxPhotoId + updateTasks.length]
      : [],
    updatePreview: updateTasks.slice(0, 20)
  }

  console.log('publish 补 photoId 预览：', JSON.stringify(summary, null, 2))

  if (DRY_RUN) {
    return summary
  }

  if (updateTasks.length > 0) {
    await updateDocsInChunks(COLLECTION_NAME, updateTasks)
  }

  return {
    ...summary,
    executed: true
  }
}