const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
const API_TOKEN = '111'

exports.main = async (event, context) => {
  try {
    const token =
      event?.queryStringParameters?.token ||
      event?.token ||
      ''

    const roleName =
      event?.queryStringParameters?.roleName ||
      event?.roleName ||
      ''

    if (token !== API_TOKEN) {
      return {
        code: 401,
        message: 'unauthorized',
        data: null
      }
    }

    const collection = db.collection('publish')

    const whereCondition = {
      status: 'APPROVED'
    }

    // 预留：按角色名筛选
    if (roleName) {
      whereCondition.roleNames = _.in([roleName])
    }

    const countRes = await collection.where(whereCondition).count()
    const total = countRes.total || 0

    if (total === 0) {
      return {
        code: 404,
        message: roleName ? `没有找到角色【${roleName}】的照片` : '没有可用照片',
        data: null
      }
    }

    const randomIndex = Math.floor(Math.random() * total)

    const result = await collection
      .where(whereCondition)
      .skip(randomIndex)
      .limit(1)
      .field({
        _id: true,
        roleNames: true,
        locationName: true,
        originUrl: true,
        thumbUrl: true,
        latitude: true,
        longitude: true,
        message: true,
        nickname: true,
        dayStr: true,
        createdAt: true,
        status: true
      })
      .get()

    const item = result.data && result.data[0]

    if (!item) {
      return {
        code: 404,
        message: '没有取到照片',
        data: null
      }
    }

    const roleNames = Array.isArray(item.roleNames) ? item.roleNames : []
    const firstRoleName = roleNames.length > 0 ? roleNames[0] : ''

    return {
      code: 0,
      message: 'success',
      data: {
        id: item._id,
        query: {
          roleName: roleName || ''
        },
        roleName: firstRoleName,
        roleNames,
        locationName: item.locationName || '',
        latitude: item.latitude ?? null,
        longitude: item.longitude ?? null,
        userMessage: item.message || '',
        nickname: item.nickname || '',
        dayStr: item.dayStr || '',
        createdAt: item.createdAt || null,
        imageUrl: item.originUrl || item.thumbUrl || '',
        thumbUrl: item.thumbUrl || ''
      }
    }
  } catch (err) {
    console.error('randomPhotoApi error:', err)
    return {
      code: 500,
      message: '服务器错误',
      error: err.message,
      data: null
    }
  }
}