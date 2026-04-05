/**
 * 云函数：login（实际更像注册/登录合并）
 *
 * 作用：
 * 1. 根据 OPENID 查找当前用户
 * 2. 若用户不存在，则创建新用户
 * 3. 新用户创建时自动分配自增 uid
 * 4. 若用户已存在，则更新昵称、头像、登录时间
 * 5. 返回前端统一使用的字段：uid / openid / nickname / avatarFileID
 *
 * 依赖：
 * - users 集合：用户表
 * - counters 集合：计数器表
 *
 * 使用前准备：
 * - counters 集合中需先有一条：
 *   { _id: 'users_uid', value: 1490, updatedAt: 0 }
 *   其中 1490 替换为你当前 users 表里的最大 uid
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const USERS = 'users'
const COUNTERS = 'counters'
const USER_UID_COUNTER_ID = 'users_uid'

exports.main = async (event, context) => {
  const { OPENID, APPID, UNIONID } = cloud.getWXContext()
  const { nickname, avatarFileID, avatarUrl } = event || {}
  const now = Date.now()

  try {
    const users = db.collection(USERS)
    const counters = db.collection(COUNTERS)

    // 1) 参数兜底：头像优先 fileID，其次 url
    const avatar =
      (typeof avatarFileID === 'string' && avatarFileID) ||
      (typeof avatarUrl === 'string' && avatarUrl) ||
      ''

    // 2) 查现有用户：兼容 _openid 与 openid
    const found = await users.where(
      _.or([
        { _openid: OPENID },
        { openid: OPENID }
      ])
    ).limit(1).get()

    // ===== 新用户：创建并分配 uid =====
    if (!found.data.length) {
      // 2.1 取并更新 uid 计数器
      const counterRes = await counters.doc(USER_UID_COUNTER_ID).get()
      const currentValue = Number(counterRes.data && counterRes.data.value) || 0
      const nextUid = currentValue + 1

      await counters.doc(USER_UID_COUNTER_ID).update({
        data: {
          value: nextUid,
          updatedAt: now
        }
      })

      // 2.2 新增用户
      const addRes = await users.add({
        data: {
          _openid: OPENID,
          openid: OPENID,
          appid: APPID || '',
          unionid: UNIONID || '',
          uid: nextUid, // ✅ 新增 uid
          nickname: nickname || '微信用户',
          avatar: avatar || '',
          role: 'user',
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now
        }
      })

      return {
        success: true,
        action: 'add',
        id: addRes._id,
        uid: nextUid, // ✅ 返回 uid
        openid: OPENID,
        nickname: nickname || '微信用户',
        avatarFileID: avatar || ''
      }
    }

    // ===== 已有用户：更新资料 =====
    const oldUser = found.data[0]
    const docId = oldUser._id
    const patch = {
      updatedAt: now,
      lastLoginAt: now
    }

    if (nickname) patch.nickname = nickname
    if (avatar) patch.avatar = avatar

    // 如果旧用户没有 uid，可以顺手补一个
    let uid = oldUser.uid || ''
    if (!uid) {
      const counterRes = await db.collection(COUNTERS).doc(USER_UID_COUNTER_ID).get()
      const currentValue = Number(counterRes.data && counterRes.data.value) || 0
      uid = currentValue + 1

      await db.collection(COUNTERS).doc(USER_UID_COUNTER_ID).update({
        data: {
          value: uid,
          updatedAt: now
        }
      })

      patch.uid = uid
    }

    await users.doc(docId).update({ data: patch })

    return {
      success: true,
      action: 'update',
      id: docId,
      uid: uid || oldUser.uid || '',
      openid: OPENID,
      nickname: nickname || oldUser.nickname || '微信用户',
      avatarFileID: avatar || oldUser.avatar || ''
    }
  } catch (e) {
    console.error('[login/registerUser] error =>', e)
    return {
      success: false,
      message: e?.message || String(e)
    }
  }
}