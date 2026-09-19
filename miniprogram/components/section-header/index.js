Component({
  properties: {
    eyebrow: {
      type: String,
      value: ''
    },
    title: {
      type: String,
      value: ''
    },
    compact: {
      type: Boolean,
      value: false
    },
    hairline: {
      type: Boolean,
      value: true
    }
  },
  options: {
    multipleSlots: true
  }
})
