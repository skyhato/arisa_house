// cloudfunctions/importRoles/index.js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const roles = [
  {"name":"戸山香澄","enabled":true,"order":2},
{"name":"花園たえ","enabled":true,"order":3},
{"name":"牛込りみ","enabled":true,"order":4},
{"name":"山吹沙綾","enabled":true,"order":5},
{"name":"市ヶ谷有咲","enabled":true,"order":6},
{"name":"美竹蘭","enabled":true,"order":7},
{"name":"青葉モカ","enabled":true,"order":8},
{"name":"上原ひまり","enabled":true,"order":9},
{"name":"宇田川巴","enabled":true,"order":10},
{"name":"羽沢つぐみ","enabled":true,"order":11},
{"name":"丸山彩","enabled":true,"order":12},
{"name":"氷川日菜","enabled":true,"order":13},
{"name":"白鷺千聖","enabled":true,"order":14},
{"name":"大和麻弥","enabled":true,"order":15},
{"name":"若宮イヴ","enabled":true,"order":16},
{"name":"湊友希那","enabled":true,"order":17},
{"name":"氷川紗夜","enabled":true,"order":18},
{"name":"今井リサ","enabled":true,"order":19},
{"name":"宇田川あこ","enabled":true,"order":20},
{"name":"白金燐子","enabled":true,"order":21},
{"name":"弦巻こころ","enabled":true,"order":22},
{"name":"瀬田薫","enabled":true,"order":23},
{"name":"北沢はぐみ","enabled":true,"order":24},
{"name":"松原花音","enabled":true,"order":25},
{"name":"ミッシェル（奥沢美咲）","enabled":true,"order":26},
{"name":"倉田ましろ","enabled":true,"order":27},
{"name":"桐谷透子","enabled":true,"order":28},
{"name":"広町七深","enabled":true,"order":29},
{"name":"二葉つくし","enabled":true,"order":30},
{"name":"八潮瑠唯","enabled":true,"order":31},
{"name":"レイヤ","enabled":true,"order":32},
{"name":"ロック","enabled":true,"order":33},
{"name":"マスキング","enabled":true,"order":34},
{"name":"パレオ","enabled":true,"order":35},
{"name":"チュチュ","enabled":true,"order":36},
{"name":"千早愛音","enabled":true,"order":37},
{"name":"要楽奈","enabled":true,"order":38},
{"name":"長崎そよ","enabled":true,"order":39},
{"name":"椎名立希","enabled":true,"order":40},
{"name":"丰川祥子","enabled":true,"order":41},
{"name":"八幡海鈴","enabled":true,"order":42},
{"name":"若葉睦","enabled":true,"order":43},
{"name":"要楽奈","enabled":true,"order":44},
{"name":"高松灯","enabled":true,"order":45},
{"name":"祐天寺若麦","enabled":true,"order":46},
{"name":"三角初華","enabled":true,"order":47}

];

exports.main = async () => {
  const BATCH = 20;
  for (let i = 0; i < roles.length; i += BATCH) {
    const chunk = roles.slice(i, i + BATCH);
    await Promise.all(chunk.map(doc => db.collection('roles').add({ data: doc })));
  }
  return { ok: true, count: roles.length };
};
