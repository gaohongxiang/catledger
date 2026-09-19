Component({
  properties: {
    title: {
      type: String,
      value: ''
    },
    note: {
      type: String,
      value: ''
    },
    ariaLabel: {
      type: String,
      value: ''
    },
    tone: {
      type: String,
      value: ''
    },
    chevron: {
      type: Boolean,
      value: true
    },
    divider: {
      type: Boolean,
      value: true
    }
  },
  options: {
    multipleSlots: true
  }
})
