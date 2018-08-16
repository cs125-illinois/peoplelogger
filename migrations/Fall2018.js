#!/usr/bin/env node

'use strict'

const _ = require('lodash')
const jsYAML = require('js-yaml')
const fs = require('fs')
const mongo = require('mongodb').MongoClient
const moment = require('moment-timezone')
const chai = require('chai')
const expect = chai.expect
chai.use(require('dirty-chai'))
const stringHash = require('string-hash')

let config = _.extend(
  jsYAML.safeLoad(fs.readFileSync('./config.yaml', 'utf8')),
  jsYAML.safeLoad(fs.readFileSync('./secrets.yaml', 'utf8')),
)

mongo.connect(config.secrets.mongo).then(async client => {
  const database = client.db(config.database)

  let stateCollection = database.collection('state')
  let peopleChangesCollection = database.collection('peopleChanges')
  let peopleCollection = database.collection('people')
  let photoCollection = database.collection('photos')
  let enrollmentCollection = database.collection('enrollment')

  // State table
  stateCollection.removeOne({ _id: 'sectionInfo' })

  // Determine counter bounds for Spring 2018
  const springStart = moment.tz(new Date(config.semesters.Spring2018.start), config.timezone).subtract(config.people.startLoggingDaysBefore, 'days')
  const springEnd = moment.tz(new Date(config.semesters.Spring2018.end), config.timezone).add(config.people.endLoggingDaysAfter, 'days')

  const counters = await peopleChangesCollection.find({
    type: 'counter', $or: [
      { semester: { $exists: false }},
      { semester: 'Spring2018' }
    ]}).toArray()

  let firstCounter, lastCounter
  for (let counter of counters) {
    const updateTime = moment(counter.state.updated)
    if (updateTime.isAfter(springStart) && firstCounter === undefined) {
      firstCounter = counter.state
    }
    if (updateTime.isAfter(springEnd)) {
      break
    }
    lastCounter = counter.state
  }

  // Fix bad counters
  await peopleChangesCollection.remove({
    semester: { $exists: false },
    'state.counter': { $lt: firstCounter.counter }
  }, true)
  await peopleChangesCollection.remove({
    semester: { $exists: false },
    'state.counter': { $gt: lastCounter.counter }
  }, true)
  await enrollmentCollection.remove({
    semester: { $exists: false },
    'state.counter': { $lt: firstCounter.counter }
  }, true)
  await enrollmentCollection.remove({
    semester: { $exists: false },
    'state.counter': { $gt: lastCounter.counter }
  }, true)
  await peopleCollection.updateMany({
    semester: { $exists: false },
    'state.counter': { $gt: lastCounter.counter }
  }, {
    $set: {
      state: lastCounter
    }
  })

  // Set semesters properly
  await peopleChangesCollection.updateMany({
    'state.counter': { $gte: firstCounter.counter },
    'state.counter': { $lte: lastCounter.counter }
  }, {
    $set: {
      semester: 'Spring2018'
    }
  })
  await enrollmentCollection.updateMany({
    'state.counter': { $gte: firstCounter.counter },
    'state.counter': { $lte: lastCounter.counter }
  }, {
    $set: {
      semester: 'Spring2018'
    }
  })
  await peopleCollection.updateMany({
    'state.counter': { $gte: firstCounter.counter },
    'state.counter': { $lte: lastCounter.counter }
  }, {
    $set: {
      semester: 'Spring2018'
    }
  })
  await peopleCollection.update({
    _id: 'challen@illinois.edu'
  }, {
    $set: {
      semester: 'Spring2018'
    }
  })

  // Validate semester setting
  const changesNoSemester = await peopleChangesCollection.find({ semester: { $exists: false }}).toArray()
  expect(changesNoSemester.length).to.equal(0)
  const peopleNoSemester = await peopleCollection.find({ semester: { $exists: false }}).toArray()
  expect(peopleNoSemester.length).to.equal(0)

  // Fix people IDs
  const people = await peopleCollection.find({ semester: 'Spring2018' }).toArray()
  const peopleLength = people.length
  for (let person of people) {
    if (person._id.endsWith('_Spring2018')) {
      continue
    }
    person._id = `${ person.email }_Spring2018`
    await peopleCollection.insert(person)
    await peopleCollection.remove({ _id: person.email }, true)
  }
  expect(peopleLength).to.equal((await peopleCollection.find({ semester: 'Spring2018'}).toArray()).length)

  let existingPhotos = _.keyBy(await photoCollection.find({}).project({
    _id: 1, email: 1
  }).toArray(), '_id')
  let bulkPhotos = photoCollection.initializeUnorderedBulkOp()
  let bulkPeople = peopleCollection.initializeUnorderedBulkOp()

  // Fix photos
  let doPhotos = false, doPeople = false
  for (let person of people) {
    if (!person.photo && !person.imageID) {
      expect(person.thumbnail).to.be.undefined
      continue
    }
    if (person.imageID) {
      expect(existingPhotos[person.imageID].email).to.equal(person.email)
      continue
    }
    const imageHash = person.photo.hash || stringHash(person.photo.contents)
    if (existingPhotos[imageHash]) {
      expect(existingPhotos[imageHash].email).to.equal(person.email)
    } else {
      doPhotos = true
      bulkPhotos.insert({
        _id: imageHash,
        email: person.email,
        full: {
          contents: person.photo.contents,
          type: person.photo.type,
          size: person.photo.size
        },
        thumbnail: person.thumbnail
      })
      existingPhotos[imageHash] = {
        email: person.email
      }
    }
    doPeople = true
    bulkPeople.find({
      _id: person._id
    }).update({
      $set: {
        imageID: imageHash
      }
    })
    bulkPeople.find({
      _id: person._id
    }).update({
      $unset: {
        'photo': 1,
        'thumbnail': 1
      }
    })
  }

  if (doPhotos) {
    await bulkPhotos.execute()
  }
  if (doPeople) {
    await bulkPeople.execute()
  }

  // Enrollment cleanup
  let bulkEnrollment = enrollmentCollection.initializeUnorderedBulkOp()
  let doBulkEnrollment = false
  let allEnrollments = await enrollmentCollection.find({ semester: 'Spring2018' }).toArray()
  for (let enrollments of allEnrollments) {
    if (enrollments.activeStudents) {
      continue
    }
    let newEnrollments = {
      activeStudents: {
        lab: {},
        lecture: {}
      },
      staff: {
        roles: {}
      },
      semester: enrollments.semester,
      state: enrollments.state
    }
    let previousID = enrollments._id
    delete(enrollments._id)
    delete(enrollments.state)
    delete(enrollments.semester)
    let totalStaff = 0, totalStudents = 0
    for (let key of _.keys(enrollments)) {
      let count = enrollments[key]
      if (key === 'TAs') {
        newEnrollments.staff.roles['TA'] = count
        totalStaff += count
      } else if (key === 'volunteers') {
        newEnrollments.staff.roles['assistant'] = count
        totalStaff += count
      } else if (key === 'developers') {
        newEnrollments.staff.roles['developer'] = count
        totalStaff += count
      } else if (key.startsWith('AY')) {
        newEnrollments.activeStudents.lab[key] = count
      } else if (key.startsWith('AL')) {
        newEnrollments.activeStudents.lecture[key] = count
        totalStudents += count
      } else {
        console.error(`Unprocessed key ${ key }`)
      }
      newEnrollments.activeStudents.total = totalStudents
      newEnrollments.staff.total = totalStaff
    }
    doBulkEnrollment = true
    bulkEnrollment.find({ _id: previousID }).replaceOne(newEnrollments)
  }

  if (doBulkEnrollment) {
    await bulkEnrollment.execute()
  }

  // Other cleanup
  await peopleCollection.updateMany({
    semester: 'Spring2018',
    active: true
  }, {
    $set: {
      left: false
    }
  })
  await peopleCollection.updateMany({
    semester: 'Spring2018',
    active: false
  }, {
    $set: {
      left: true
    }
  })
  await peopleCollection.updateMany({
    semester: 'Spring2018',
    role: 'volunteer'
  }, {
    $set: {
      role: 'assistant'
    }
  })

  // Sanity checking
  let peopleMissingSemester = await peopleCollection.find({ semester: { $exists: false } }).toArray()
  expect(peopleMissingSemester.length).to.equal(0)

  let peopleChangesMissingSemester = await peopleChangesCollection.find({ semester: { $exists: false } }).toArray()
  expect(peopleChangesMissingSemester.length).to.equal(0)

  let enrollmentCollectionMissingSemester = await enrollmentCollection.find({ semester: { $exists: false } }).toArray()
  expect(enrollmentCollectionMissingSemester.length).to.equal(0)

  return client
}).catch(err => {
  console.error(err.stack)
  process.exit(-1)
}).then(client => {
  client.close()
})

// vim: ts=2:sw=2:et:ft=javascript
