const DEFAULT_CATEGORIES = Object.freeze([
  { kind: 'expense', systemKey: 'food', name: '餐饮', sortOrder: 10 },
  { kind: 'expense', systemKey: 'transport', name: '交通', sortOrder: 20 },
  { kind: 'expense', systemKey: 'shopping', name: '购物', sortOrder: 30 },
  { kind: 'expense', systemKey: 'housing', name: '居住', sortOrder: 40 },
  { kind: 'expense', systemKey: 'utilities', name: '生活缴费', sortOrder: 50 },
  { kind: 'expense', systemKey: 'medical', name: '医疗', sortOrder: 60 },
  { kind: 'expense', systemKey: 'education', name: '教育', sortOrder: 70 },
  { kind: 'expense', systemKey: 'entertainment', name: '娱乐', sortOrder: 80 },
  { kind: 'expense', systemKey: 'social', name: '人情', sortOrder: 90 },
  { kind: 'expense', systemKey: 'other_expense', name: '其他支出', sortOrder: 100 },
  { kind: 'income', systemKey: 'salary', name: '工资', sortOrder: 10 },
  { kind: 'income', systemKey: 'bonus', name: '奖金', sortOrder: 20 },
  { kind: 'income', systemKey: 'part_time', name: '兼职', sortOrder: 30 },
  { kind: 'income', systemKey: 'investment', name: '理财收益', sortOrder: 40 },
  { kind: 'income', systemKey: 'gift', name: '礼金', sortOrder: 50 },
  { kind: 'income', systemKey: 'other_income', name: '其他收入', sortOrder: 60 }
])

module.exports = {
  DEFAULT_CATEGORIES
}
