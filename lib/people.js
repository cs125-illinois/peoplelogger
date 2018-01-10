#!/usr/bin/env node

'use strict'

require('dotenv').config()
const appRootPath = require('app-root-path').toString()
const _ = require('lodash')
const debug = require('debug')('people')

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
async function people (config, database) {
  npmPath.setSync()

  /*
   * Scrape from my.cs.illinois.edu
   */
  let command = `casperjs lib/people-my.cs.illinois.edu --course=${config.course}`
  var options = {
    maxBuffer: 1024 * 1024 * 1024,
    cwd: appRootPath
  }
  if (config.sections) {
    command += ` --sections=${config.sections}`
  }
  if (config.debug) {
    command += ` --verbose`
    options.stdio = [0, 1, 2]
  }
  debug(`Running ${command}`)
  let currentPeople = JSON.parse(childProcess.execSync(command, options).toString())

  // Can't recover the JSON in this case, so just return
  if (config.debug) {
    return
  }
  debug(`Saw ${_.keys(currentPeople).length} people`)

  /*
   * Normalize retrieved data.
   */
  const matchClassID = new RegExp('\\s+(\\w+)$')
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
      classes: (() => {
        _.each(person.classes, c => {
          c.ID = c['CRN']
          c.name = matchClassID.exec(c['class'].trim())[0].trim()
          delete (c['CRN'])
          delete (c['class'])
          c['credits'] = parseInt(c['credits'])
        })
        return person.classes
      })()
    }
    _.each(person.classes, c => {
      person[c.name] = true
    })
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
    return normalizedPerson
  })
  currentPeople = _.mapKeys(normalizedPeople, person => {
    return person.email
  })

  /*
   * Save to Mongo.
   */

  let stateCollection = database.collection('state')
  let peopleCollection = database.collection(config.collection)
  let changesCollection = database.collection(config.collection + "Changes")

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
      state: _.omit(state, 'id')
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
        state: _.omit(state, 'id'),
        diff: personDiff
      })
    }
  }))

  await Promise.all(_.map(left, async leftPerson => {
    await changesCollection.insert({
      type: 'left',
      email: existingPeople[leftPerson].email,
      state: _.omit(state, 'id')
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

  return stateCollection.save(state)
}

if (require.main === module) {
  require('dotenv').config()
  let argv = require('minimist')(process.argv.slice(2))
  let client
  mongo.connect(process.env.MONGO)
    .then(c => {
      client = c
      return people(argv, client.db('people'))
    }).then(() => {
      client.close()
    })
}
module.exports = (config) => {
  expect(config.section).to.not.be.ok('section option can only be used when debugging from the comand line')
  expect(config.reset).to.not.be.ok('reset can only be used from debugging from the command line')
  expect(config.debug).to.not.be.ok('debug option can only be used from the command line')
  return people(config)
}

// vim: ts=2:sw=2:et:ft=javascript
