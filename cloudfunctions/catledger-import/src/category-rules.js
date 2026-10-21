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
  ['food__meal', 'food', /早餐|午餐|晚餐|早饭|午饭|晚饭|夜宵|餐费|堂食|便当|快餐|火锅|烧烤|米饭|盖饭|炒饭|面条|牛肉面|麻辣烫|饺子|馄饨|汉堡|披萨|拌面|拉面|套餐|盒饭|工作餐|小吃/, /餐厅|饭店|餐馆|小吃店|快餐|火锅|烧烤|肯德基|麦当劳|海底捞|沙县|面馆|饺子馆/, /餐具|餐盘|玩具|模型|火锅底料|烧烤架/],
  ['food__drink', 'food', /咖啡|奶茶|茶饮|果汁|饮料|酸奶|拿铁|美式|生椰|柠檬水|果茶|奶茶|茶饮|饮品/, /咖啡店|咖啡馆|奶茶店|茶饮店|星巴克|瑞幸|喜茶|蜜雪冰城|霸王茶姬|古茗|茶百道|沪上阿姨/, /咖啡机|咖啡杯|咖啡壶|咖啡磨|奶茶机|果汁机|榨汁机/],
  ['food__snack', 'food', /水果|零食|坚果|饼干|薯片|糕点|蛋糕|面包|巧克力|蔬菜|海鲜|生鲜|熟食/, /水果店|零食店|糕点店|蛋糕店|面包店|超市|生鲜|便利店|永辉|盒马|山姆|沃尔玛|华润万家|罗森|全家/, /水果刀|水果机|面包机|蛋糕模具|饼干模具|超市卡/],
  ['transport__public', 'transport', /地铁|公交|公共交通|乘车码|城际|轮渡/, /地铁|公交集团|一卡通/, /玩具|模型/],
  ['transport__taxi', 'transport', /网约车|打车|出租车|租车费|快车|专车|顺风车|行程费用/, /出租车|网约车|滴滴出行|高德打车|曹操出行|T3出行/, /玩具|模型/],
  ['transport__car', 'transport', /加油费|燃油费|停车费|过路费|通行费|汽车保养|车辆保养|洗车|充电桩|汽车充电|汽油|柴油|92号|95号|98号|加油/, /加油站|汽车维修|汽车保养|洗车店|中国石化|中国石油|壳牌|充电/, /玩具|模型|加油卡|购物卡/],
  ['transport__train', 'transport', /火车票|高铁票|动车票|铁路客票/, /12306|铁路/, /手续费/],
  ['transport__flight', 'transport', /机票|航空客票/, /航空|机场/, /手续费/],
  ['transport', 'transport', /共享单车|骑行|单车月卡|助力车|电动车/, /哈啰|美团单车|青桔/, /玩具|模型/],
  ['shopping__electronics', 'shopping', /鼠标|键盘|耳机|充电宝|显示器|平板|相机|音箱|路由器|硬盘|U盘|数据线|充电器|笔记本|电脑|手机|家电|空调|冰箱|洗衣机|电视|扫地机/, /小米|华为|苹果官网|Apple|京东|苏宁|国美|顺电/, /手机充值|话费|流量|手机壳|手机膜|手机支架/],
  ['shopping__houseware', 'shopping', /洗衣液|洗衣粉|纸巾|抽纸|卷纸|清洁剂|洗洁精|垃圾袋|毛巾|拖鞋|衣架|收纳|锅具|餐具|床品|四件套|拖把|扫把|日用品|家居用品|厨具/, /超市|日用|家居|宜家|名创优品/, /餐具套装/],
  ['shopping__clothing', 'shopping', /T恤|衬衫|连衣裙|外套|裤子|牛仔裤|裙子|卫衣|羽绒服|大衣|内衣|袜子|鞋子|运动鞋|皮鞋|凉鞋|帽子|围巾|服饰|女装|男装|童装/, /优衣库|ZARA|H&M|耐克|阿迪达斯|李宁|安踏|海澜之家|太平鸟/, /饰品|鞋柜|衣柜/],
  ['shopping__beauty', 'shopping', /洗面奶|面霜|精华|口红|面膜|护肤品|化妆品|洗发水|沐浴露|牙膏|防晒|彩妆|香水/, /屈臣氏|丝芙兰|林清轩|完美日记|花西子/, /美容仪/],
  ['medical__treatment', 'medical', /挂号|诊疗|门诊|住院|体检|检查费|治疗费|口腔治疗|洗牙|拔牙|补牙|疫苗|接种|手术|康复|理疗/, /医院|诊所|体检中心|卫生院|口腔|牙科/, /玩具|模型/],
  ['medical__medicine', 'medical', /药品|药费|购药|处方药|感冒药|退烧药|消炎药|中药|西药/, /药店|药房|大药房/, /药店会员/],
  ['medical__device', 'medical', /医疗器械|血压计|血糖仪|体温计|轮椅|制氧机|口罩|创可贴/, null, /玩具|模型/],
  ['utilities__water_power', 'utilities', /水费|电费|水电费/],
  ['utilities__gas', 'utilities', /天然气费|燃气费/],
  ['utilities__property', 'utilities', /物业费/],
  ['utilities__heating', 'utilities', /取暖费|供暖费/],
  ['housing__rent', 'housing', /房租|住房租金/],
  ['housing__repairs', 'housing', /房屋维修|装修施工|装修费|维修资金|维修基金|大修基金/],
  ['communication__phone', 'communication', /话费|流量费|手机充值|流量包|话费充值|通讯费/],
  ['communication__internet', 'communication', /网费|宽带费|宽带缴费|宽带|光纤/],
  ['housing__housekeeping', 'life_services', /家政|保洁|清洁服务|搬家|钟点工/, /家政服务|保洁服务|搬家/, /搬家费/],
  ['communication__postage', 'life_services', /快递|寄件|邮寄|运费|代收|驿站|取件/, /快递|邮政速递|驿站/, /代收款/],
  ['life_services', 'life_services', /理发|剪发|烫发|染发|美发|美容|美甲|足疗|按摩|干洗|洗衣|洗鞋|熨烫/, /理发店|美发店|美容院|美甲店|足浴|洗衣店|干洗店/, /美容仪|洗衣机|洗衣液|洗衣粉|柔顺剂|洗衣凝珠/],
  ['education__books', 'education', /书籍|图书|教材|教辅/, /书店/],
  ['education__courses', 'education', /培训费|课程费|学费/],
  ['education__exams', 'education', /考试费|认证考试|考试报名/],
  ['entertainment__shows', 'entertainment', /电影票|演出票|戏剧门票|音乐会门票|话剧|演唱会|展览门票/, /电影院|影城|大剧院|剧场/, /电影海报/],
  ['entertainment__games', 'entertainment', /游戏充值|游戏点卡|玩具|积木|手办|盲盒|桌游/, /游戏|玩具/, /游戏账号/],
  ['entertainment__subscriptions', 'entertainment', /会员订阅|视频会员|音乐会员|大会员|黑胶VIP|VIP会员|超级会员|连续包月|网易云|腾讯视频|爱奇艺|优酷|芒果TV|哔哩哔哩/, /视频|音乐|阅读|会员/, /会员卡充值/],
  ['entertainment__travel', 'entertainment', /酒店|民宿|客栈|度假村|景点门票|景区|旅游|跟团|自由行|签证/, /携程|去哪儿|飞猪|途牛|同程|酒店|宾馆/, /酒店用品/],
  ['finance__insurance', 'finance', /保险|保费/, /保险/, /保险箱|保险柜|保险丝/],
  ['finance__tax', 'finance', /税费|税款|个人所得税|个税|增值税|印花税|社保|公积金/],
  ['finance__service', 'finance', /手续费|服务费|年费|账户管理费/],
  ['finance__interest', 'finance', /贷款利息|分期利息|借款利息|利息/, null, /利息收入/],
  ['social__donations', 'social', /公益捐赠|慈善捐款|捐款|捐助|公益/],
  ['entertainment__fitness', 'entertainment__fitness', /健身房|健身卡|私教|瑜伽|游泳|球场|羽毛球|网球|拳击|健身/, /健身房|瑜伽馆|球馆|游泳馆/, /健身器材|健身餐/],
  ['entertainment__pets', null, /宠物|猫粮|狗粮|猫砂|犬粮|宠物疫苗|宠物美容/, /宠物店|宠物医院|宠物店/]
]
const INCOME = [
  ['salary__base', 'salary', /工资|薪资/, null, /加班|兼职/],
  ['salary__overtime', 'salary', /加班费|加班工资/],
  ['bonus__performance', 'bonus', /绩效奖金/],
  ['bonus__annual', 'bonus', /年终奖/],
  ['part_time__side_job', 'part_time', /兼职收入|兼职工资|兼职劳务|劳务费|外快/],
  ['investment__returns', 'investment', /投资收益|理财收益|基金分红|股票分红|分红|理财/],
  ['investment__rental', 'investment', /租金收入|房租收入|收租/],
  ['investment__interest', 'investment', /利息收入|存款利息|银行利息/],
  ['gift__gift_money', 'gift', /礼金|礼金红包|红包收入/],
  ['gift__winnings', 'other_income', /彩票中奖|中奖收入|中奖/]
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
