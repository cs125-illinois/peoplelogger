'use strict'

const _ = require('lodash')
const got = require('got')
const getGravatar = require('gravatar')
const peopleLib = require('./people')

async function gravatar (config) {
  let peopleCollection = config.database.collection('people')
  let bulkPeople = peopleCollection.initializeUnorderedBulkOp()
  let doPeople = false

  let people = _.pickBy(await peopleLib.getAllPeople(config.database), person => {
    return !person.instructor
  })
  let distinctPeople = _.keyBy(people, 'email')
  for (let person of _.values(distinctPeople)) {
    const url = getGravatar.url(person.email, { s: '460', d: '404' }, false)
    let hasGravatar
    try {
      await got.head(url)
      hasGravatar = true
    } catch (err) {
      if (err.statusCode === 404) {
        hasGravatar = false
      }
    }
    config.log.debug(person.email, hasGravatar)
    if (hasGravatar !== undefined && person.hasGravatar !== hasGravatar) {
      doPeople = true
      bulkPeople.find({ email: person.email }).update({ $set: { hasGravatar } })
    }
  }
  if (doPeople) {
    await bulkPeople.execute()
  }
}

module.exports = exports = {
  gravatar
}

// vim: ts=2:sw=2:et:ft=javascript
