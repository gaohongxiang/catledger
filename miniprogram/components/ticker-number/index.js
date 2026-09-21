Component({
  properties: {
    value: {
      type: String,
      value: ''
    }
  },
  data: {
    parts: []
  },
  observers: {
    value: function (value) {
      const text = String(value == null ? '' : value)
      const parts = []
      for (let index = 0; index < text.length; index++) {
        const ch = text.charAt(index)
        if (ch >= '0' && ch <= '9') {
          parts.push({ key: 'd' + index, digit: true, top: '-' + (Number(ch) * 1.1) + 'em' })
        } else {
          parts.push({ key: 's' + index, digit: false, ch: ch })
        }
      }
      this.setData({ parts: parts })
    }
  }
})
