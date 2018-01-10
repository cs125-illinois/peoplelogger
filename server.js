#!/usr/bin/env node

'use strict'

const _ = require('lodash')
const debug = require('debug')('people')
const tmp = require('tmp')
tmp.setGracefulCleanup()
const jsYAML = require('js-yaml')
const fs = require('fs')

const npmPath = require('npm-path')
const chai = require('chai')
const expect = chai.expect
chai.use(require('dirty-chai'))
const childProcess = require('child_process')
const emailValidator = require('email-validator')
const base64JS = require('base64-js')
const imageType = require('image-type')
const imageSize = require('image-size')
const stringHash = require('string-hash')
const mongo = require('mongodb').MongoClient
const moment = require('moment')
const deepDiff = require('deep-diff').diff
const googleSpreadsheetToJSON = require('google-spreadsheet-to-json')
const emailAddresses = require('email-addresses')

/*
 * Example object from my.cs.illinois.edu:
 *
 * "Action": "",
 * "Admit Term": "Fall 2017",
 * "College": "Liberal Arts & Sciences",
 * "Degree": "BSLAS",
 * "FERPA": "N",
 * "Gender": "M",
 * "Level": "1U",
 * "Major 1 Name": "Computer Sci & Chemistry",
 * "Name": "Last, First",
 * "Net ID": "lastfirst",
 * "UIN": "123456789",
 * "Year": "Sophomore",
 * "classes": [
 *  {
 *    "class": "CS 125 AL3",
 *    "CRN": "50158",
 *    "credits": "4"
 *  },
 *  {
 *    "class": "CS 125 AYT",
 *    "CRN": "69488"
 *  }
 * ],
 */

const blankPhoto = '1758209682'
async function people (config) {

  /*
   * Grab staff info.
   */

  let getStaff = async (name) => {
    let staff = []
    let sheet = await googleSpreadsheetToJSON({
      spreadsheetId: '1UkEOdYgHRPxlP8uDrQVJRlgbTSRzcWdiPOB5rvtX3mc',
      credentials: config.secrets.google,
      propertyMode: 'none',
      worksheet: [ name ]
    })
    _.each(sheet, inner => {
      _.each(inner, person  => {
        if ('Email' in person) {
          staff.push(person['Email'])
        }
      })
    })
    return staff
  }

  let TAs = await getStaff('TAs')
  let volunteers = await getStaff('Volunteers')
  let developers = await getStaff('Developers')
  let staff = _.union(TAs, volunteers, developers)

  /*
   * Add staff to my.cs.illinois.edu
   */

  let staffNetIDs = _.map(staff, email => {
    return emailAddresses.parseOneAddress(email).local
  })

  npmPath.setSync()
  let configFile = tmp.fileSync()
  fs.writeFileSync(configFile.name, JSON.stringify(config))
  let addCommand = `casperjs lib/add-my.cs.illinois.edu ${ configFile.name } --netIDs=${ staffNetIDs.join(',') }`
  var options = {
    maxBuffer: 1024 * 1024 * 1024,
  }
  if (config.debug) {
    options.stdio = [0, 1, 2]
    addCommand += ' --verbose'
  }
  debug(`Running ${addCommand}`)
  childProcess.execSync(addCommand, options)

  /*
   * Scrape from my.cs.illinois.edu
   */


  let getCommand = `casperjs lib/get-my.cs.illinois.edu ${ configFile.name }`
  var options = {
    maxBuffer: 1024 * 1024 * 1024,
  }
  if (config.debug) {
    options.stdio = [0, 1, 2]
    getCommand += ' --verbose'
  }

  debug(`Running ${getCommand}`)
  if (config.debug) {
    // Can't recover the JSON in this case, so just return
    childProcess.execSync(getCommand, options)
    return
  }
  let currentPeople = JSON.parse(childProcess.execSync(getCommand, options).toString())
  debug(`Saw ${_.keys(currentPeople).length} people`)

  /*
   * Normalize retrieved data.
   */
  const matchClassID = new RegExp('\\s+(\\w+)$')
  let allSections = {}
  let normalizedPeople = _.mapValues(currentPeople, person => {
    let email = person['Net ID'] + `@illinois.edu`
    expect(emailValidator.validate(email)).to.be.true()

    let name = person['Name'].split(',')
    expect(name).to.have.lengthOf.above(1)
    let firstName = name[1].trim()
    let lastName = [name[0].trim(), name.slice(2).join('').trim()].join(' ')

    let normalizedPerson = {
      email: email,
      admitted: person['Admit Term'],
      college: person['College'],
      degree: person['Degree'],
      gender: person['Gender'],
      level: person['Level'],
      major: person['Major 1 Name'],
      hidden: (person['FERPA'] === 'Y'),
      name: {
        full: firstName + ' ' + lastName.trim(),
        first: firstName.trim(),
        last: lastName.trim()
      },
      username: person['Net ID'],
      ID: person['UIN'],
      year: person['Year'],
      sections: (() => {
        return _.reduce(person.classes, (all, c) => {
          c.ID = c['CRN']
          c.name = matchClassID.exec(c['class'].trim())[0].trim()
          delete (c['CRN'])
          delete (c['class'])
          c['credits'] = parseInt(c['credits'])
          all[c.name] = c
          allSections[c.name] = true
          return all
        }, {})
      })()
    }
    if (stringHash(person.image) !== blankPhoto) {
      let photoData = base64JS.toByteArray(person.image)
      let photoType = imageType(photoData)
      expect(photoType).to.not.be.null()
      var photoSize = imageSize(Buffer.from(photoData))
      expect(photoSize).to.not.be.null()
      normalizedPerson.photo = {
        contents: person.image,
        type: photoType,
        size: photoSize
      }
    }
    if (TAs.indexOf(email) !== -1) {
      normalizedPerson.role = 'TA'
    } else if (developers.indexOf(email) !== -1) {
      normalizedPerson.role = 'developer'
    } else if (volunteers.indexOf(email) !== -1) {
      normalizedPerson.role = 'volunteer'
    } else {
      normalizedPerson.role = 'student'
    }
    return normalizedPerson
  })
  currentPeople = _.mapKeys(normalizedPeople, person => {
    return person.email
  })
  allSections = _.keys(allSections)

  /*
   * Save to Mongo.
   */

  let client = await mongo.connect(config.secrets.mongo)
  let database = client.db('people')

  let stateCollection = database.collection('state')
  let peopleCollection = database.collection(config.collection)
  let changesCollection = database.collection(config.collection + "Changes")
  let enrollmentCollection = database.collection(config.collection + 'Enrollment')

  if (config.reset) {
    stateCollection.deleteMany({})
    peopleCollection.deleteMany({})
    changesCollection.deleteMany({})
  }

  let state = await stateCollection.findOne({ _id: config.collection })
  if (state === null) {
    state = {
      _id: config.collection,
      counter: 1
    }
  } else {
    state.counter++
  }
  state.updated = moment().toDate()

  let allPeople = _.reduce(await peopleCollection.find()
    .toArray(), (p, person) => {
      delete(person._id)
      delete(person.state)
      p[person.email] = person
      return p
    }, {})
  let existingPeople = _.pickBy(allPeople, person => {
    return person.active
  })
  _.each(allPeople, person => {
    delete(person.active)
  })
  _.each(existingPeople, person => {
    delete(person.active)
  })

  let joined = _.difference(_.keys(currentPeople), _.keys(existingPeople))
  let left = _.difference(_.keys(existingPeople), _.keys(currentPeople))
  let same = _.intersection(_.keys(currentPeople), _.keys(existingPeople))
  debug(`${ left.length } left, ${ joined.length } joined, ${ same.length } same`)

  let prepareForAddition = (person) => {
    person._id = person.email
    person.state = _.omit(state, '_id')
    return person
  }

  await Promise.all(_.map(joined, async newPerson => {
    await changesCollection.insert({
      type: 'joined',
      email: currentPeople[newPerson].email,
      state: _.omit(state, '_id')
    })
    if (!(newPerson in allPeople)) {
      return await peopleCollection.insert(prepareForAddition(currentPeople[newPerson]))
    } else {
      same.push(newPerson)
    }
  }))

  await Promise.all(_.map(same, async samePerson => {
    let existingPerson = allPeople[samePerson]
    let currentPerson = currentPeople[samePerson]

    let personDiff = deepDiff(existingPerson, currentPerson)
    await peopleCollection.save(prepareForAddition(currentPerson))

    if (personDiff !== undefined) {
      await changesCollection.insert({
        type: 'change',
        email: existingPerson.email,
        state: _.omit(state, '_id'),
        diff: personDiff
      })
    }
  }))

  await Promise.all(_.map(left, async leftPerson => {
    await changesCollection.insert({
      type: 'left',
      email: existingPeople[leftPerson].email,
      state: _.omit(state, '_id')
    })
  }))

  await peopleCollection.updateMany({
    "state.counter": { $eq : state.counter },
  }, {
    $set: { active: true }
  })
  await peopleCollection.updateMany({
    "state.counter": { $ne : state.counter },
  }, {
    $set: { active: false }
  })
  let enrollments = {}
  _.each(allSections, section => {
    enrollments[section] = _(currentPeople)
    .filter(person => {
      return person.role === 'student' && (section in person.sections)
    })
    .value().length
  })
  enrollments['TAs'] = TAs.length
  enrollments['volunteers'] = volunteers.length
  enrollments['developers'] = developers.length
  enrollments.state = _.omit(state, '_id')

  await enrollmentCollection.insert(enrollments)

  await stateCollection.save(state)

  client.close()
}

let config = _.extend(
  jsYAML.safeLoad(fs.readFileSync('config.yaml', 'utf8')),
  jsYAML.safeLoad(fs.readFileSync('secrets.yaml', 'utf8')),
  require('minimist')(process.argv.slice(2))
)
debug(config)
people(config)

// vim: ts=2:sw=2:et:ft=javascript
