const colorNameFor = require('../../utils/category-palette').colorNameFor

Component({
  properties: {
    name: {
      type: String,
      value: ''
    },
    color: {
      type: String,
      value: ''
    },
    size: {
      type: String,
      value: 'normal'
    },
    hideName: {
      type: Boolean,
      value: false
    }
  },
  data: {
    resolvedColor: 'grey',
    initial: ''
  },
  observers: {
    'name, color': function (name, color) {
      this.setData({
        resolvedColor: color || colorNameFor(name),
        initial: name ? name.slice(0, 1) : ''
      })
    }
  },
  options: {
    multipleSlots: true
  }
})
