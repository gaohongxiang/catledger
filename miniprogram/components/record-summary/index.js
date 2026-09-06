Component({
  properties: {
    total: { type: Number, value: 0 },
    active: { type: Number, value: 0 },
    excluded: { type: Number, value: 0 },
    duplicate: { type: Number, value: 0 }
  },
  data: { expanded: false },
  methods: {
    // 仅切换本地说明，不改变记录选择、核对结果或服务端状态。
    toggleCountDetails: function () { this.setData({ expanded: !this.data.expanded }) }
  }
})
