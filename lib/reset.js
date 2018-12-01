'use strict'

const _ = require('lodash')
const promptly = require('promptly')

async function resetSemester (config, semester) {
  let stateCollection = config.database.collection('state')
  let peopleCollection = config.database.collection('people')
  let changesCollection = config.database.collection('peopleChanges')
  let enrollmentCollection = config.database.collection('enrollment')

  await stateCollection.deleteMany({ _id: semester })
  await peopleCollection.deleteMany({ semester })
  await changesCollection.deleteMany({ semester })
  await enrollmentCollection.deleteMany({ semester })
}

async function reset (config) {
  if (config.resetAll) {
    let reset = await promptly.choose('Are you sure you want to reset the entire peoplelogger collection?', ['yes', 'no'])
    if (reset === 'yes') {
      for (let semester of _.keys(config.semesters)) {
        await resetSemester(config, semester)
      }
    } else {
      config.log.debug('Skipping reset')
    }
  } else if (config.resetOne) {
    let reset = await promptly.choose(`Are you sure you want to reset the ${config.resetOne} peoplelogger collection?`, ['yes', 'no'])
    if (reset === 'yes') {
      await resetSemester(config, config.resetOne)
    } else {
      config.log.debug('Skipping reset')
    }
  }
}

module.exports = exports = {
  reset
}

// vim: ts=2:sw=2:et:ft=javascript
