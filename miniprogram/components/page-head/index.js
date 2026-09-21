Component({
  properties: {
    hasActions: {
      type: Boolean,
      value: false
    },
    badge: {
      type: String,
      value: ''
    },
    title: {
      type: String,
      value: ''
    },
    copy: {
      type: String,
      value: ''
    }
  },
  options: {
    multipleSlots: true
  }
})
