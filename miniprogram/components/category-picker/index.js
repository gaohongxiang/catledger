const tree = require('../../utils/category-tree')
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    remote: { type: Boolean, value: false },
    range: { type: Array, value: [] }, value: { type: Number, value: -1 },
    disabled: { type: Boolean, value: false }, title: { type: String, value: '选择分类' }
  },
  data: { open: false, query: '', groups: [], parentCaption: '' },
  observers: {
    'range, value': function (range, value) {
      const selected = tree.labelRows(range)[value]
      this.setData({ parentCaption: selected && selected.parentName || '' })
      if (this.data.open) this.refresh()
    },
    disabled: function (value) { if (value) this.setData({ open: false }) }
  },
  pageLifetimes: { hide: function () { this.setData({ open: false }) } },
  methods: {
    show: function () {
      if (this.data.disabled) return
      if (this.data.remote) { this.triggerEvent('browse'); return }
      this._expanded = {}; this.setData({ open: true, query: '' }); this.refresh()
    },
    close: function () { this.setData({ open: false }) },
    stop: function () {},
    search: function (event) { this._expanded = {}; this.setData({ query: event.detail.value }); this.refresh() },
    refresh: function () { this.setData({ groups: tree.selectionGroups(this.data.range, this.data.query, this._expanded || {}, this.data.value) }) },
    toggle: function (event) {
      const key = event.currentTarget.dataset.key, group = this.data.groups.find(row => row.key === key)
      if (!group) return
      this._expanded = this._expanded || {}; this._expanded[key] = !group.expanded; this.refresh()
    },
    choose: function (event) {
      const index = Number(event.currentTarget.dataset.index), row = this.data.range[index]
      if (this.data.disabled || !row || row.archived || row.archivedAt || row.isPlaceholder) return
      this.setData({ open: false }); this.triggerEvent('change', { value: index })
    }
  }
})
