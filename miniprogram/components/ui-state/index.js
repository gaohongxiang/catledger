Component({
  properties: {
    title: {
      type: String,
      value: ''
    },
    description: {
      type: String,
      value: ''
    },
    error: {
      type: Boolean,
      value: false
    },
    centered: {
      type: Boolean,
      value: false
    }
  },
  options: {
    multipleSlots: true
  }
})
