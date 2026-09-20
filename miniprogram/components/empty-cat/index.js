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
    hideArt: {
      type: Boolean,
      value: false
    }
  },
  options: {
    multipleSlots: true
  }
})
