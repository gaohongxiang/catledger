const ROOT_CATEGORIES = Object.freeze([
  { kind: 'expense', systemKey: 'food', name: '餐饮', sortOrder: 10 },
  { kind: 'expense', systemKey: 'transport', name: '交通', sortOrder: 20 },
  { kind: 'expense', systemKey: 'shopping', name: '购物', sortOrder: 30 },
  { kind: 'expense', systemKey: 'housing', name: '居住', sortOrder: 40 },
  { kind: 'expense', systemKey: 'utilities', name: '生活缴费', sortOrder: 50 },
  { kind: 'expense', systemKey: 'medical', name: '医疗', sortOrder: 60 },
  { kind: 'expense', systemKey: 'education', name: '教育', sortOrder: 70 },
  { kind: 'expense', systemKey: 'entertainment', name: '娱乐', sortOrder: 80 },
  { kind: 'expense', systemKey: 'social', name: '人情', sortOrder: 90 },
  { kind: 'expense', systemKey: 'communication', name: '通讯', sortOrder: 91 },
  { kind: 'expense', systemKey: 'finance', name: '金融保险', sortOrder: 92 },
  { kind: 'expense', systemKey: 'other_expense', name: '其他支出', sortOrder: 100 },
  { kind: 'income', systemKey: 'salary', name: '工资', sortOrder: 10 },
  { kind: 'income', systemKey: 'bonus', name: '奖金', sortOrder: 20 },
  { kind: 'income', systemKey: 'part_time', name: '兼职', sortOrder: 30 },
  { kind: 'income', systemKey: 'investment', name: '理财收益', sortOrder: 40 },
  { kind: 'income', systemKey: 'gift', name: '礼金', sortOrder: 50 },
  { kind: 'income', systemKey: 'other_income', name: '其他收入', sortOrder: 60 }
])

// Adapted from ezBookkeeping presets (MIT); existing root keys and financial semantics are retained.
const CHILDREN = {
  food: [["meal", "餐食"], ["drink", "饮品"], ["snack", "水果零食"]],
  transport: [["public", "公共交通"], ["taxi", "打车租车"], ["car", "养车用车"], ["train", "火车"], ["flight", "机票"]],
  shopping: [["clothing", "衣物鞋包"], ["jewelry", "饰品"], ["beauty", "美容美发"], ["houseware", "日用家居"], ["electronics", "数码电器"]],
  housing: [["rent", "房租"], ["repairs", "维修装修"], ["housekeeping", "家政服务"]],
  utilities: [["water_power", "水电"], ["gas", "燃气"], ["property", "物业"], ["heating", "取暖"]],
  medical: [["treatment", "诊疗"], ["medicine", "药品"], ["device", "医疗器械"]],
  education: [["books", "书刊"], ["courses", "培训课程"], ["exams", "考试认证"]],
  entertainment: [["fitness", "运动健身"], ["party", "聚会"], ["shows", "电影演出"], ["games", "玩具游戏"], ["subscriptions", "会员订阅"], ["pets", "宠物"], ["travel", "旅行"]],
  social: [["gifts", "送礼"], ["donations", "捐赠"]],
  communication: [["phone", "话费"], ["internet", "网费"], ["postage", "快递邮寄"]],
  finance: [["insurance", "保险"], ["tax", "税费"], ["service", "手续费"], ["interest", "利息"], ["fine", "赔偿罚款"]],
  salary: [["base", "基本工资"], ["overtime", "加班收入"]],
  bonus: [["performance", "绩效奖金"], ["annual", "年终奖"]],
  part_time: [["side_job", "兼职收入"]],
  investment: [["returns", "投资收益"], ["rental", "租金收入"], ["interest", "利息收入"]],
  gift: [["gift_money", "礼金红包"], ["winnings", "中奖收入"]]
}
const DEFAULT_CATEGORIES = Object.freeze(ROOT_CATEGORIES.concat(ROOT_CATEGORIES.flatMap(parent =>
  (CHILDREN[parent.systemKey] || []).map(([key, name], index) => ({
    kind: parent.kind, systemKey: parent.systemKey + '__' + key, parentSystemKey: parent.systemKey,
    name, sortOrder: (index + 1) * 10
  })))))
module.exports = { DEFAULT_CATEGORIES, ROOT_CATEGORIES }
