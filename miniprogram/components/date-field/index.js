const cal = require('./calendar')

// 统一日期输入组件：支持三种粒度，通过 slot 定制触发外观，事件统一派发 change。
//   granularity:
//     'date'     选某天 → value 'YYYY-MM-DD'
//     'month'    选某月 → value 'YYYY-MM'
//     'datetime' 选某天某时 → 'YYYY-MM-DD HH:mm'（value 带时间时）
// 定位规则：有值停值，空值停今天（datetime 的月份选择与 date 共用日历）。
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    value: { type: String, value: '' },
    granularity: { type: String, value: 'date' }, // date | month | datetime
    disabled: { type: Boolean, value: false },
    title: { type: String, value: '' },
    placeholder: { type: String, value: '选择日期' }
  },
  data: {
    open: false,
    mode: 'days',        // 'days' 日历 | 'years' 年快选 | 'months' 月快选
    viewYear: 2026, viewMonth: 1,
    selectedDate: '',    // 当前值里的日期部分 YYYY-MM-DD
    cells: [], weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    todayStr: '',
    yearList: [], monthList: [],
    hour: '00', minute: '00', hours: [], minutes: []
  },
  observers: {
    value: function (value) { if (!this.data.open) this.setAux(value); },
    disabled: function (value) { if (value) this.setData({ open: false }); }
  },
  lifetimes: {
    attached: function () {
      const hours = [], minutes = []
      for (let i = 0; i < 24; i += 1) hours.push(cal.pad(i))
      for (let i = 0; i < 60; i += 1) minutes.push(cal.pad(i))
      const t = cal.todayParts()
      const years = []
      for (let y = t.year - 30; y <= t.year + 5; y += 1) years.push(y)
      const months = []
      for (let m = 1; m <= 12; m += 1) months.push(m)
      this.setData({ hours, minutes, yearList: years, monthList: months, todayStr: cal.ymd(t.year, t.month, t.day) })
      this.setAux(this.data.value)
    }
  },
  pageLifetimes: { hide: function () { this.setData({ open: false }) } },
  methods: {
    // 根据当前 value 计算选中日期/时间与面板定位（有值停值、空停今天）
    setAux: function (value) {
      const p = cal.parse(value)
      const t = cal.todayParts()
      const anchor = p || t
      const timeMatch = /(\d{2}):(\d{2})/.exec(String(value == null ? '' : value))
      this.setData({
        viewYear: anchor.year, viewMonth: anchor.month,
        selectedDate: p && p.day ? cal.ymd(p.year, p.month, p.day) : '',
        hour: timeMatch ? timeMatch[1] : '00',
        minute: timeMatch ? timeMatch[2] : '00'
      })
    },
    renderCells: function () {
      this.setData({ cells: cal.monthGrid(this.data.viewYear, this.data.viewMonth) })
    },
    show: function () {
      if (this.data.disabled) return
      this.setAux(this.data.value)
      const mode = this.data.granularity === 'month' ? 'months' : 'days'
      this.setData({ open: true, mode })
      this.renderCells()
    },
    close: function () { this.setData({ open: false }) },
    stop: function () {},
    prevMonth: function () { const s = cal.shiftMonth(this.data.viewYear, this.data.viewMonth, -1); this.setData(s); this.renderCells() },
    nextMonth: function () { const s = cal.shiftMonth(this.data.viewYear, this.data.viewMonth, 1); this.setData(s); this.renderCells() },
    switchMode: function (event) { this.setData({ mode: event.currentTarget.dataset.mode }) },
    pickDay: function (event) {
      const date = event.currentTarget.dataset.date
      if (this.data.granularity === 'date') { this.emit(date); this.setData({ selectedDate: date }); this.setData({ open: false }); return }
      // datetime：先选日，保留右侧时间
      this.setData({ selectedDate: date })
    },
    pickYear: function (event) { this.setData({ viewYear: Number(event.currentTarget.dataset.year), mode: 'months' }) },
    pickMonth: function (event) { this.setData({ viewMonth: Number(event.currentTarget.dataset.month), mode: 'days' }); this.renderCells() },
    pickHour: function (event) { this.setData({ hour: event.detail.value }) },
    pickMinute: function (event) { this.setData({ minute: event.detail.value }) },
    // month 粒度：年+月 两级，选完立即提交
    pickMonthOnly: function (event) { const m = Number(event.currentTarget.dataset.month); this.setData({ viewMonth: m, mode: 'days' }); this.renderCells() },
    confirm: function () {
      if (this.data.granularity === 'month') { this.emit(cal.ym(this.data.viewYear, this.data.viewMonth)); this.setData({ open: false }); return }
      if (this.data.granularity === 'datetime') {
        const date = this.data.selectedDate || this.data.todayStr
        const time = this.data.hour + ':' + this.data.minute
        this.triggerEvent('change', { value: date + ' ' + time, date, time }); this.setData({ open: false }); return
      }
      const date = this.data.selectedDate || this.data.todayStr
      this.emit(date); this.setData({ open: false })
    },
    emit: function (value) { this.triggerEvent('change', { value }) }
  }
})
