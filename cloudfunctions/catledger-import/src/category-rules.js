const { canonicalName, sourceFields } = require('./category-memory')

const CATEGORY_RULE_VERSION = 'category-rules-v4'
const ALIPAY_SYSTEM_KEYS = Object.freeze({
  餐饮美食: 'food', 交通出行: 'transport', 爱车养车: 'transport__car',
  服饰装扮: 'shopping__clothing', 日用百货: 'shopping__houseware', 家居家装: 'shopping',
  数码电器: 'shopping__electronics', 美容美发: 'shopping__beauty', 宠物: 'entertainment__pets',
  运动户外: 'entertainment__fitness', 酒店旅游: 'entertainment__travel', 文化休闲: 'entertainment',
  生活服务: 'life_services', 公益捐赠: 'social__donations', 教育培训: 'education',
  医疗健康: 'medical', 保险: 'finance__insurance', 投资理财: 'investment'
})

// 明确的用途词才细分；同级或跨类冲突由 summarize 处理，不按规则顺序抢占。
// [系统键, 当前父级, 商品/用途证据, 商户证据, 排除词]
const EXPENSE = [
  ['food__meal', 'food', /早餐|午餐|晚餐|早饭|午饭|晚饭|夜宵|餐费|堂食|便当|快餐|火锅|烧烤|米饭|盖饭|炒饭|面条|牛肉面|麻辣烫|饺子|馄饨|汉堡|披萨/, /餐厅|饭店|餐馆|小吃店|快餐|火锅|烧烤/, /餐具|餐盘|玩具|模型|火锅底料|烧烤架/],
  ['food__drink', 'food', /咖啡|奶茶|茶饮|果汁|饮料|酸奶/, /咖啡店|咖啡馆|奶茶店|茶饮店/, /咖啡机|咖啡杯|咖啡壶|咖啡磨|奶茶机|果汁机|榨汁机/],
  ['food__snack', 'food', /水果|零食|坚果|饼干|薯片|糕点|蛋糕|面包|巧克力/, /水果店|零食店|糕点店|蛋糕店|面包店/, /水果刀|水果机|面包机|蛋糕模具|饼干模具/],
  ['transport__public', 'transport', /地铁|公交|公共交通|乘车码/, /地铁|公交集团/, /玩具|模型/],
  ['transport__taxi', 'transport', /网约车|打车|出租车|租车费/, /出租车|网约车|滴滴出行/, /玩具|模型/],
  ['transport__car', 'transport', /加油费|燃油费|停车费|过路费|通行费|汽车保养|车辆保养|洗车|充电桩|汽车充电/, /加油站|汽车维修|汽车保养|洗车店/],
  ['transport__train', 'transport', /火车票|高铁票|动车票|铁路客票/, null, /手续费/],
  ['transport__flight', 'transport', /机票|航空客票/, null, /手续费/],
  ['medical__treatment', 'medical', /挂号|诊疗|门诊|住院|体检|检查费|治疗费|口腔治疗/, /医院|诊所|体检中心/],
  ['medical__medicine', 'medical', /药品|药费|购药|处方药/, /药店|药房/],
  ['medical__device', 'medical', /医疗器械|血压计|血糖仪|体温计/],
  ['utilities__water_power', 'utilities', /水费|电费|水电费/],
  ['utilities__gas', 'utilities', /天然气费|燃气费/],
  ['utilities__property', 'utilities', /物业费/],
  ['utilities__heating', 'utilities', /取暖费|供暖费/],
  ['housing__rent', 'housing', /房租|住房租金/],
  ['housing__repairs', 'housing', /房屋维修|装修施工|装修费/],
  ['communication__phone', 'communication', /话费|流量费|手机充值/],
  ['communication__internet', 'communication', /网费|宽带费|宽带缴费/],
  ['housing__housekeeping', 'life_services', /家政|保洁|清洁服务/, /家政服务|保洁服务/],
  ['communication__postage', 'life_services', /快递|寄件|邮寄|运费/, /快递|邮政速递/],
  ['education__books', 'education', /书籍|图书|教材|教辅/, /书店/],
  ['education__courses', 'education', /培训费|课程费|学费/],
  ['education__exams', 'education', /考试费|认证考试|考试报名/],
  ['entertainment__shows', 'entertainment', /电影票|演出票|戏剧门票|音乐会门票/, /电影院/],
  ['entertainment__games', 'entertainment', /游戏充值|游戏点卡|玩具|积木/],
  ['entertainment__subscriptions', 'entertainment', /会员订阅|视频会员|音乐会员/],
  ['finance__insurance', 'finance', /保险|保费/, /保险/, /保险箱|保险柜|保险丝/],
  ['finance__tax', 'finance', /税费|税款|个人所得税/],
  ['finance__service', 'finance', /手续费/],
  ['finance__interest', 'finance', /贷款利息|分期利息|借款利息/],
  ['social__donations', 'social', /公益捐赠|慈善捐款/],
  ['entertainment__pets', null, /宠物|猫粮|狗粮|猫砂|犬粮/, /宠物店|宠物医院/]
]
const INCOME = [
  ['salary__base', 'salary', /工资|薪资/, null, /加班|兼职/],
  ['salary__overtime', 'salary', /加班费|加班工资/],
  ['bonus__performance', 'bonus', /绩效奖金/],
  ['bonus__annual', 'bonus', /年终奖/],
  ['part_time__side_job', 'part_time', /兼职收入|兼职工资|兼职劳务/],
  ['investment__returns', 'investment', /投资收益|理财收益|基金分红|股票分红/],
  ['investment__rental', 'investment', /租金收入|房租收入/],
  ['investment__interest', 'investment', /利息收入|存款利息/],
  ['gift__gift_money', 'gift', /礼金|礼金红包/],
  ['gift__winnings', 'other_income', /彩票中奖|中奖收入/]
]

function summarize(matches) {
  const distinct = [...new Map(matches.map(rule => [rule[0], rule])).values()]
  if (!distinct.length) return null
  if (distinct.length === 1) return { systemKey: distinct[0][0], parentSystemKey: distinct[0][1], ambiguous: false }
  const roots = [...new Set(distinct.map(rule => rule[1] || rule[0]))]
  return { systemKey: roots.length === 1 ? roots[0] : null, parentSystemKey: null, ambiguous: true }
}

function categoryRule(sourceType, row) {
  const raw = sourceFields(row), item = canonicalName(raw.item), merchant = canonicalName(raw.counterparty)
  const direction = row.direction || row.normalized && row.normalized.direction || 'expense'
  const rules = direction === 'income' ? INCOME : EXPENSE
  const match = (text, slot) => rules.filter(rule => rule[slot] && rule[slot].test(text) &&
    !(rule[4] && rule[4].test(slot === 3 ? item + merchant : text)))
  let productMatches = match(item, 2)
  // 宠物诊疗/用品属于宠物，不套用人的医疗或食品分类。
  if (direction === 'expense' && /宠物|猫粮|狗粮|猫砂|犬粮/.test(item + merchant) &&
      productMatches.every(rule => /^(?:food|medical)__/.test(rule[0]) || rule[0] === 'entertainment__pets')) {
    productMatches = [EXPENSE[EXPENSE.length - 1]]
  }
  const detail = summarize(productMatches) || summarize(match(merchant, 3))
  const sourceKey = sourceType === 'alipay' ? ALIPAY_SYSTEM_KEYS[canonicalName(raw.transactionType)] || null : null
  return { detail, sourceKey }
}

module.exports = { CATEGORY_RULE_VERSION, categoryRule }
