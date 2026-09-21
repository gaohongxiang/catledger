Component({
  properties: {
    rows: {
      type: Number,
      value: 3
    }
  },
  data: {
    items: [0, 1, 2]
  },
  observers: {
    rows: function (rows) {
      const count = Math.max(1, Math.min(8, Math.round(Number(rows) || 3)))
      const items = []
      for (let index = 0; index < count; index++) items.push(index)
      this.setData({ items: items })
    }
  }
})
