const _ = require('lodash')

async function counter (config) {
  let stateCollection = config.database.collection('state')
  let state = await stateCollection.findOne({ _id: 'peoplelogger' })
  if (state === null) {
    state = {
      _id: 'peoplelogger',
      counter: 1
    }
  } else {
    state.counter++
  }
  state.updated = config.runTime.toDate()
  config.log.debug(state)
  await stateCollection.replaceOne({
    _id: 'peoplelogger'
  }, state, { upsert: true })
  config.state = _.omit(state, '_id')
}

module.exports = exports = {
  counter
}
