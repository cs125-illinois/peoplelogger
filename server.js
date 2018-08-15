#!/usr/bin/env node

'use strict'

const _ = require('lodash')
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
const moment = require('moment-timezone')
const deepDiff = require('deep-diff').diff
const googleSpreadsheetToJSON = require('google-spreadsheet-to-json')
const emailAddresses = require('email-addresses')
const ip = require('ip')
const asyncLib = require('async')
const promptly = require('promptly')
const requestJSON = require('request-json')
const queryString = require('query-string')
const StrictPasswordGenerator = require('strict-password-generator').default
const passwordGenerator = new StrictPasswordGenerator()
const sleep = require('sleep')
const resizeImg = require('resize-img')

const bunyan = require('bunyan')
const log = bunyan.createLogger({
  name: 'peoplelogger',
  streams: [
    {
      type: 'rotating-file',
      path: 'logs/peoplelogger-info.log',
      period: '1d',
      count: 365,
      level: 'info'
    },
    {
      type: 'rotating-file',
      path: 'logs/peoplelogger-debug.log',
      period: '1d',
      count: 28,
      level: 'debug'
    }
  ]
})

const runTime = moment()
npmPath.setSync()

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
  let stateCollection = config.database.collection('state')

  if (config.resetAll) {
    let reset = await promptly.choose('Are you sure you want to reset the entire peoplelogger database?', ['yes', 'no'])
    if (reset === 'yes') {
      stateCollection.deleteMany({ _id: 'currentSemester' })
      for (let semester of _.keys(config.semesters)) {
        await resetSemester(config, semester)
      }
    } else {
      log.debug('Skipping reset')
    }
  } else if (config.resetOne) {
    let reset = await promptly.choose(`Are you sure you want to reset the ${config.resetOne} peoplelogger database?`, ['yes', 'no'])
    if (reset === 'yes') {
      await resetSemester(config, config.resetOne)
    } else {
      log.debug('Skipping reset')
    }
  }
}

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
  state.updated = runTime.toDate()
  await stateCollection.save(state)
  config.state = _.omit(state, '_id')
}

function semesterIsActive (semester, config, daysBefore, daysAfter) {
  let semesterStart = moment.tz(new Date(config.semesters[semester].start), config.timezone)
  let semesterEnd = moment.tz(new Date(config.semesters[semester].end), config.timezone)
  daysBefore = daysBefore !== undefined ? daysBefore : config.semesterStartsDaysBefore
  daysAfter = daysAfter !== undefined ? daysAfter : config.semesterEndsDaysAfter
  semesterStart = semesterStart.subtract(daysBefore, 'days')
  semesterEnd = semesterEnd.add(daysAfter, 'end')
  return runTime.isBetween(semesterStart, semesterEnd)
}

async function state (config) {
  let stateCollection = config.database.collection('state')
  let bulkState = stateCollection.initializeUnorderedBulkOp()

  _.each(config.semesters, (semesterConfig, semester) => {
    let sectionCommand = `./lib/get-courses.illinois.edu ${semesterConfig.courses}`
    log.debug(`Running ${sectionCommand}`)
    try {
      let sections = JSON.parse(childProcess.execSync(sectionCommand))
      if (semesterConfig.extraSections) {
        sections = _.extend(sections, semesterConfig.extraSections)
      }
      bulkState.find({ _id: semester }).upsert().update({
        $set: {
          sections,
          start: moment.tz(new Date(semesterConfig.start), config.timezone).toDate(),
          end: moment.tz(new Date(semesterConfig.end), config.timezone).toDate(),
          counter: config.state.counter
        }
      })
    } catch (err) {
      throw err
    }
  })

  let currentSemester = _(config.semesters).pickBy((semesterConfig, semester) => {
    return semesterIsActive(semester, config)
  }).keys().value()
  expect(currentSemester.length).to.be.within(0, 1)
  if (currentSemester.length === 1) {
    currentSemester = currentSemester[0]
    bulkState.find({ _id: 'currentSemester' }).upsert().replaceOne({
      currentSemester
    })
    log.debug(`Current semester is ${currentSemester}`)
  } else {
    bulkState.find({ _id: 'currentSemester' }).removeOne()
    log.debug(`No current semester`)
  }

  await bulkState.execute()
}

function addStaffToMyCS (config, semester, emails) {
  let netIDs = _.map(emails, email => {
    return emailAddresses.parseOneAddress(email).local
  }).join(',')
  let configFile = tmp.fileSync()
  let addConfig = {
    subject: config.subject,
    semester: config.semesters[semester].name,
    number: config.semesters[semester].staffCourse.number,
    section: config.semesters[semester].staffCourse.section,
    netIDs,
    secrets: config.secrets
  }
  fs.writeFileSync(configFile.name, JSON.stringify(addConfig))

  let addCommand = `casperjs lib/add-my.cs.illinois.edu ${configFile.name}`
  var options = {
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  }
  if (config.debugAdd) {
    options.stdio = [0, 1, 2]
    addCommand += ' --verbose'
  }

  log.debug(`Running ${addCommand}`)
  try {
    childProcess.execSync(addCommand, options)
  } catch (err) {
    log.warn(err)
  }
}

async function getEmailsFromSheet (config, sheetID, worksheet, key = 'Email') {
  const sheets = await googleSpreadsheetToJSON({
    spreadsheetId: sheetID,
    credentials: config.secrets.google,
    propertyMode: 'none',
    worksheet
  })

  let people = {}
  for (let index in sheets) {
    const sheet = sheets[index]
    const name = worksheet[index]
    for (let person of sheet) {
      const email = person[key]
      expect(email).to.be.ok()
      expect(people).to.not.have.property(email)
      people[email] = name
    }
  }
  return people
}

const MATCH_CLASS_ID = new RegExp('\\s+(\\w+)$')
async function getFromMyCS (config, semester, getConfig) {
  let configFile = tmp.fileSync()
  fs.writeFileSync(configFile.name, JSON.stringify(getConfig))

  let getCommand = `casperjs lib/get-my.cs.illinois.edu ${configFile.name}`
  var options = {
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  }
  if (config.debugGet) {
    options.stdio = [0, 1, 2]
    getCommand += ' --verbose'
  }

  log.debug(`Running ${getCommand}`)
  if (config.debugGet) {
    // Can't recover the JSON in this case, so just return
    childProcess.execSync(getCommand, options)
    return
  }
  try {
    var currentPeople = JSON.parse(childProcess.execSync(getCommand, options).toString())
  } catch (err) {
    // Throw to make sure that we don't run other tasks
    throw err
  }

  expect(_.keys(currentPeople)).to.have.lengthOf.above(1)
  log.debug(`Saw ${_.keys(currentPeople).length} people`)

  return _(currentPeople).mapValues(person => {
    let email = person['Net ID'] + `@illinois.edu`
    expect(emailValidator.validate(email)).to.be.true()

    let name = person['Name'].split(',')
    expect(name).to.have.lengthOf.above(1)
    let firstName = name[1].trim()
    let lastName = [name[0].trim(), name.slice(2).join('').trim()].join(' ')
    if (firstName === '-') {
      firstName = ''
    }

    let normalizedPerson = {
      email,
      semester,
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
      instructor: false,
      state: config.state,
      image: person.image
    }

    if (firstName === '') {
      normalizedPerson.name.full = lastName
    }

    normalizedPerson.sections = _(person.classes).map(info => {
      let section = {
        ID: info['CRN'],
        name: MATCH_CLASS_ID.exec(info['class'].trim())[0].trim()
      }
      section.credits = parseInt(info.credits)
      if (isNaN(section.credits)) {
        delete (info.credits)
      }
      return section
    }).keyBy(section => {
      return section.name
    }).value()
    normalizedPerson.totalCredits = _.reduce(normalizedPerson.sections, (total, section) => {
      return section.credits ? total + section.credits : total
    }, 0)

    return normalizedPerson
  }).keyBy('email').value()
}

const BLANK_PHOTO = 1758209682
async function addPhotos (config, people) {
  let photoCollection = config.database.collection('photos')
  let bulkPhotos = photoCollection.initializeUnorderedBulkOp()
  let existingPhotos = _.keyBy(photoCollection.find({}).project({
    _id: 1, email: 1
  }).toArray(), '_id')
  log.debug(`${_.keys(existingPhotos).length} existing photos`)

  for (let person of people) {
    const imageHash = stringHash(person.image)
    if (imageHash === BLANK_PHOTO) {
      continue
    }
    if (existingPhotos[imageHash]) {
      expect(existingPhotos[imageHash].email).to.equal(person.email)
    } else {
      let photoData = base64JS.toByteArray(person.image)
      let photoType = imageType(photoData)
      expect(photoType).to.not.be.null()
      var photoSize = imageSize(Buffer.from(photoData))
      expect(photoSize).to.not.be.null()

      let widthRatio = photoSize.width / config.thumbnail
      let heightRatio = photoSize.height / config.thumbnail
      let ratio = Math.min(widthRatio, heightRatio)
      let thumbnail = {
        type: photoType,
        size: {
          width: Math.round(photoSize.width * (1 / ratio)),
          height: Math.round(photoSize.height * (1 / ratio))
        }
      }
      expect(Math.max(thumbnail.size.width, thumbnail.size.height))
        .to.be.within(Math.round(config.thumbnail) - 1, Math.round(config.thumbnail) + 1)
      let thumbnailImage = await resizeImg(Buffer.from(photoData), {
        width: thumbnail.size.width,
        height: thumbnail.size.height
      })
      thumbnail.contents = base64JS.fromByteArray(thumbnailImage)

      bulkPhotos.insert({
        _id: imageHash,
        email: person.email,
        full: {
          contents: person.image,
          type: photoType,
          size: photoSize
        },
        thumbnail
      })
    }
  }

  await bulkPhotos.execute()
}

async function staff (config) {
  let currentSemesters = _(config.semesters).pickBy((semesterConfig, semester) => {
    return semesterIsActive(semester, config, config.people.startLoggingDaysBefore, config.people.endLoggingDaysAfter)
  }).keys().value()
  for (let currentSemester of currentSemesters) {
    let staff = {}
    let TAsAndCDs = await getEmailsFromSheet(config, config.semesters[currentSemester].staffSheet, ['TAs', 'CDs'])
    staff.TAs = _(TAsAndCDs).pickBy(sheet => {
      return sheet === 'TAs'
    }).keys().value()
    staff.developers = _(TAsAndCDs).pickBy(sheet => {
      return sheet === 'CDs'
    }).keys().value()
    let CAs = await getEmailsFromSheet(config, config.semesters[currentSemester].CASheet, ['Form Responses 1'], 'Email Address')
    staff.assistants = _.keys(CAs).filter(email => {
      return staff.developers.indexOf(email) === -1
    })
    staff.all = [ ...staff.TAs, ...staff.developers, ...staff.assistants ]

    addStaffToMyCS(config, currentSemester, staff.all)

    let currentStaff = await getFromMyCS(config, currentSemester, {
      subject: config.subject,
      semester: config.semesters[currentSemester].name,
      number: config.semesters[currentSemester].staffCourse.number,
      sections: [ config.semesters[currentSemester].staffCourse.section ],
      secrets: config.secrets
    })

    expect(_.keys(currentStaff).length).to.equal(staff.all.length)

    _.each(currentStaff, staffMember => {
      staffMember.semester = currentSemester
      staffMember.staff = true
      staffMember.student = false
    })
    _.each(staff.TAs, email => {
      expect(currentStaff).to.have.property(email)
      let person = currentStaff[email]
      expect(person).to.not.have.property('role')
      person.role = 'TA'
    })
    _.each(staff.developers, email => {
      expect(currentStaff).to.have.property(email)
      let person = currentStaff[email]
      expect(person).to.not.have.property('role')
      person.role = 'developer'
    })
    _.each(staff.assistants, email => {
      expect(currentStaff).to.have.property(email)
      let person = currentStaff[email]
      expect(person).to.not.have.property('role')
      person.role = 'assistant'
    })

    await addPhotos(config, _.values(currentStaff))
    _.each(currentStaff, person => {
      delete(person.image)
    })


  }
}

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

async function getExistingPeople (collection) {
  if (!collection) {
    var client = await mongo.connect(config.secrets.mongo)
    collection = client.db(config.database).collection('people')
  }
  let people = _.reduce(await collection.find({
    active: true
  }).toArray(), (people, person) => {
    people[person.email] = person
    return people
  }, {})
  if (client) {
    client.close()
  }
  return people
}

async function getAllPeople (collection) {
  if (!collection) {
    var client = await mongo.connect(config.secrets.mongo)
    collection = client.db(config.database).collection('people')
  }
  let people = _.reduce(await collection.find({}).toArray(), (people, person) => {
    people[person.email] = person
    return people
  }, {})
  if (client) {
    client.close()
  }
  return people
}

const blankPhoto = '1758209682'
async function people (config) {
  /*
   * Initialize mongo.
   */
  let database = config.client.db(config.database)

  let peopleCollection = database.collection('people')
  let changesCollection = database.collection('peopleChanges')
  let enrollmentCollection = database.collection('enrollment')

  /*
   * Grab office hour info.
   */
  let officeHourStaff = []
  let sheet = await googleSpreadsheetToJSON({
    spreadsheetId: config.officehours,
    credentials: config.secrets.google,
    propertyMode: 'none',
    worksheet: [ 'Weekly Schedule' ]
  })
  _.each(sheet, inner => {
    _.each(inner, row => {
      if (row['Assistants']) {
        _.each(row['Assistants'].toString().split(','), email => {
          email = `${email.toLowerCase().trim()}@illinois.edu`
          if (staff.indexOf(email) !== -1) {
            officeHourStaff.push(email)
          }
        })
      }
    })
  })
  officeHourStaff = _.uniq(officeHourStaff)

  /*
   * Scrape from my.cs.illinois.edu
   */
  let getCommand = `casperjs lib/get-my.cs.illinois.edu ${configFile.name}`
  var options = {
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  }
  if (config.debugGet) {
    options.stdio = [0, 1, 2]
    getCommand += ' --verbose'
  }
  if (config.sections) {
    getCommand += ` --sections=${config.sections}`
  }

  log.debug(`Running ${getCommand}`)
  if (config.debugGet) {
    // Can't recover the JSON in this case, so just return
    childProcess.execSync(getCommand, options)
    return
  }
  try {
    var currentPeople = JSON.parse(childProcess.execSync(getCommand, options).toString())
  } catch (err) {
    // Throw to make sure that we don't run other tasks
    throw err
  }
  expect(_.keys(currentPeople)).to.have.lengthOf.above(1)
  log.debug(`Saw ${_.keys(currentPeople).length} people`)

  /*
   * Get all people before we look at images so that we
   * can avoid repetitive thumbnail creation.
   */
  let allPeople = _.reduce(await peopleCollection.find({
    instructor: false
  }).toArray(), (p, person) => {
    delete (person._id)
    delete (person.state)
    p[person.email] = person
    return p
  }, {})

  /*
   * Normalize retrieved data.
   */
  const matchClassID = new RegExp('\\s+(\\w+)$')
  let allSections = {}
  let normalizedPeople = []
  for (let person of _.values(currentPeople)) {
    let email = person['Net ID'] + `@illinois.edu`
    expect(emailValidator.validate(email)).to.be.true()

    let name = person['Name'].split(',')
    expect(name).to.have.lengthOf.above(1)
    let firstName = name[1].trim()
    let lastName = [name[0].trim(), name.slice(2).join('').trim()].join(' ')
    if (firstName === '-') {
      firstName = ''
    }

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
      instructor: false
    }
    let previousPerson = allPeople[normalizedPerson.email]

    if (firstName === '') {
      normalizedPerson.name.full = lastName
    }
    let totalCredits = 0
    normalizedPerson.sections = _.reduce(person.classes, (all, c) => {
      c.ID = c['CRN']
      c.name = matchClassID.exec(c['class'].trim())[0].trim()
      delete (c['CRN'])
      delete (c['class'])
      if (c['credits']) {
        c['credits'] = parseInt(c['credits'])
      }
      if (isNaN(c['credits'])) {
        delete (c['credits'])
      } else {
        totalCredits += c['credits']
      }
      all[c.name] = c
      allSections[c.name] = true
      normalizedPerson[c.name] = true
      if (c.name.startsWith(config.labPrefix)) {
        normalizedPerson.lab = c.name
      }
      return all
    }, {})
    let photoHash = stringHash(person.image)
    if (photoHash !== blankPhoto) {
      let photoData = base64JS.toByteArray(person.image)
      let photoType = imageType(photoData)
      expect(photoType).to.not.be.null()
      var photoSize = imageSize(Buffer.from(photoData))
      expect(photoSize).to.not.be.null()
      normalizedPerson.photo = {
        contents: person.image,
        type: photoType,
        size: photoSize,
        hash: photoHash
      }
      if (previousPerson && previousPerson.photo &&
          previousPerson.thumbnail && (previousPerson.photo.hash === photoHash)) {
        normalizedPerson.thumbnail = previousPerson.thumbnail
      }
      if (!(normalizedPerson.thumbnail)) {
        let widthRatio = photoSize.width / config.thumbnail
        let heightRatio = photoSize.height / config.thumbnail
        let ratio = Math.min(widthRatio, heightRatio)
        let thumbnail = {
          type: photoType,
          size: {
            width: Math.round(photoSize.width * (1 / ratio)),
            height: Math.round(photoSize.height * (1 / ratio))
          }
        }
        expect(Math.max(thumbnail.size.width, thumbnail.size.height))
          .to.be.within(Math.round(config.thumbnail) - 1, Math.round(config.thumbnail) + 1)
        let thumbnailImage = await resizeImg(Buffer.from(photoData), {
          width: thumbnail.size.width,
          height: thumbnail.size.height
        })
        thumbnail.contents = base64JS.fromByteArray(thumbnailImage)
        normalizedPerson.thumbnail = thumbnail
      }

      // Copy over anything we want to preserve from our previous people.
      if (previousPerson && previousPerson.survey) {
        normalizedPerson.survey = previousPerson.survey
      }
    }

    if (TAs.indexOf(email) !== -1) {
      normalizedPerson.role = 'TA'
      normalizedPerson.staff = true
      normalizedPerson.student = false
      normalizedPerson.section = true
      normalizedPerson.officehours = true
      normalizedPerson.scheduled = true
      delete (normalizedPerson.sections)
      delete (normalizedPerson[config.addTo])
    } else if (developers.indexOf(email) !== -1) {
      normalizedPerson.role = 'developer'
      normalizedPerson.staff = true
      normalizedPerson.student = false
      normalizedPerson.section = false
      normalizedPerson.officehours = false
      normalizedPerson.scheduled = true
      delete (normalizedPerson.sections)
      delete (normalizedPerson[config.addTo])
    } else if (volunteers.indexOf(email) !== -1) {
      normalizedPerson.role = 'volunteer'
      normalizedPerson.staff = true
      normalizedPerson.student = false
      normalizedPerson.officehours = (officeHourStaff.indexOf(email) !== -1)
      normalizedPerson.scheduled = (officeHourStaff.indexOf(email) !== -1)
      delete (normalizedPerson.sections)
      delete (normalizedPerson[config.addTo])
    } else if (totalCredits > 0) {
      normalizedPerson.student = true
      normalizedPerson.role = 'student'
      normalizedPerson.staff = false
    } else {
      normalizedPerson.student = false
      normalizedPerson.role = 'other'
      normalizedPerson.staff = false
    }
    if (normalizedPerson.role === 'TA' || normalizedPerson.role === 'volunteer') {
      let mySections = allStaff[email]['Section']
      if (mySections && mySections.trim().length > 0) {
        let sections = mySections.trim().split(',')
        _.each(sections, section => {
          section = section.trim()
          expect(sectionInfo).to.have.property(section)
          normalizedPerson[section] = true
          normalizedPerson.scheduled = true
          normalizedPerson.section = true
        })
        normalizedPerson.sections = sections
      }
    }
    normalizedPeople.push(normalizedPerson)
  }
  currentPeople = _.mapKeys(normalizedPeople, person => {
    return person.email
  })
  allSections = _.keys(allSections)
  _.each(sectionInfo, (section, name) => {
    if (config.sectionInfo[name]) {
      section.active = (config.sectionInfo[name].active === true)
    } else {
      section.active = (allSections.indexOf(section.name) !== -1)
    }
  })

  /*
   * Save to Mongo.
   */
  if (!(config.dry_run)) {
    var state = await stateCollection.findOne({ _id: 'peoplelogger' })
    if (state === null) {
      state = {
        _id: 'peoplelogger',
        counter: 1
      }
    } else {
      state.counter++
    }
    state.updated = moment().toDate()

    await stateCollection.save({
      _id: 'sectionInfo',
      updated: state.updated,
      sections: sectionInfo
    })
  }

  let existingPeople = _.pickBy(allPeople, person => {
    return person.active
  })
  _.each(allPeople, person => {
    delete (person.active)
  })
  _.each(existingPeople, person => {
    delete (person.active)
  })

  let joined = _.difference(_.keys(currentPeople), _.keys(existingPeople))
  let left = _.difference(_.keys(existingPeople), _.keys(currentPeople))
  let same = _.intersection(_.keys(currentPeople), _.keys(existingPeople))
  log.debug(`${left.length} left, ${joined.length} joined, ${same.length} same`)

  expect(left.length, 'Everyone left').to.not.equal(existingPeople.length)

  if (config.dry_run) {
    return
  }

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

  await changesCollection.insert({
    type: 'counter',
    state: _.omit(state, '_id')
  })

  await peopleCollection.updateMany({
    'state.counter': { $eq: state.counter }
  }, {
    $set: { active: true }
  })
  await peopleCollection.updateMany({
    instructor: false,
    'state.counter': { $ne: state.counter }
  }, {
    $set: { active: false }
  })
  let enrollments = {}
  _.each(allSections, section => {
    enrollments[section] = _(currentPeople)
      .filter(person => {
        if (person.role !== 'student') {
          return false
        }
        if (!(section in person.sections)) {
          return false
        }
        let totalCredits = 0
        _.each(person.sections, section => {
          if (section.credits) {
            totalCredits += section.credits
          }
        })
        return totalCredits > 0
      })
      .value().length
  })
  enrollments['TAs'] = TAs.length
  enrollments['volunteers'] = _(currentPeople)
    .filter(person => {
      return person.role === 'volunteer' && person.scheduled
    })
    .value().length
  enrollments['developers'] = developers.length
  enrollments.state = _.omit(state, '_id')

  await enrollmentCollection.insert(enrollments)
  await stateCollection.save(state)
}

async function mailman (config) {
  /*
   * Update mailman lists.
   */
  if (ip.address() !== config.server) {
    log.warn(`skipping mailman since we are not on the mail server`)
    return
  }
  let existingPeople = await getExistingPeople()

  let instructors = _(existingPeople)
    .filter(p => {
      return p.instructor === true
    })
    .reduce((people, person) => {
      people[person.email] = person
      return people
    }, {})

  let syncList = (name, members, moderators) => {
    members = _.extend(_.clone(members), instructors)
    moderators = _.map(_.extend(_.clone(moderators), instructors), 'email')
    let membersFile = tmp.fileSync().name
    fs.writeFileSync(membersFile, _.map(members, p => {
      return `"${p.name.full}" <${p.email}>`
    }).join('\n'))
    log.debug(`${name} has ${_.keys(members).length} members`)
    childProcess.execSync(`sudo remove_members -a -n -N ${name} 2>/dev/null`)
    childProcess.execSync(`sudo add_members -w n -a n -r ${membersFile} ${name} 2>/dev/null`)
    childProcess.execSync(`sudo withlist -r set_mod ${name} -s -a 2>/dev/null`)
    childProcess.execSync(`sudo withlist -r set_mod ${name} -u ${moderators.join(' ')}  2>/dev/null`)
  }
  let TAs = _.pickBy(existingPeople, person => {
    return person.role === 'TA'
  })
  let volunteers = _.pickBy(existingPeople, person => {
    return person.role === 'volunteer'
  })
  let developers = _.pickBy(existingPeople, person => {
    return person.role === 'developer'
  })
  let students = _.pickBy(existingPeople, person => {
    return person.role === 'student'
  })
  let labs = _.pickBy(existingPeople, person => {
    return person.section === true
  })
  let EMP = _.pickBy(existingPeople, person => {
    return person.staff && person.EMP
  })
  syncList('staff', TAs, TAs)
  syncList('assistants', volunteers)
  syncList('developers', developers)
  syncList('labs', labs)
  syncList('students', _.extend(_.clone(students), TAs, volunteers, developers), TAs)
  syncList('EMP', EMP, EMP)
}

const passwordOptions = { minimumLength: 10, maximumLength: 12 }
async function discourse (config) {
  let existingPeople = _.pickBy(await getExistingPeople(), p => {
    return p.instructor === false
  })
  expect(_.keys(existingPeople).length, 'Everyone left').to.be.at.least(1)

  let moderators = _.pickBy(existingPeople, person => {
    return person.role === 'TA' || person.role === 'volunteer' || person.role === 'developer'
  })
  let users = _.pickBy(existingPeople, person => {
    return person.role === 'student'
  })
  existingPeople = _.extend(_.clone(moderators), users)

  let discourse = requestJSON.createClient(config.discourse)
  let callDiscourseAPI = async (verb, path, query, body) => {
    if (query === null) {
      query = {}
    }
    query = _.extend(_.clone(query), {
      api_username: config.secrets.discourse.username,
      api_key: config.secrets.discourse.key
    })
    path += '?' + queryString.stringify(query)
    log.debug(path)

    for (let retry = 0; retry < 15; retry++) {
      if (verb === 'get') {
        var result = await discourse.get(path)
      } else if (verb === 'put' || verb === 'post') {
        var result = await discourse[verb](path, body)
      } else if (verb === 'delete') {
        discourse.headers['X-Requested-With'] = 'XMLHTTPRequest'
        var result = await discourse.delete(path)
      }
      if (result.res.statusCode === 429 || result.res.statusCode === 500) {
        log.warn(`Sleeping for ${result.res.statusCode}`)
        discourse = requestJSON.createClient(config.discourse)
        sleep.sleep(5)
      } else {
        break
      }
    }
    expect(result.res.statusCode).to.equal(200)
    return result.body
  }

  await callDiscourseAPI('put', 'admin/site_settings/enable_local_logins', null, {
    enable_local_logins: true
  })

  let getAllUsers = async () => {
    let discoursePeople = {}
    for (let page = 0; ; page++) {
      let newUsers = await callDiscourseAPI('get', 'admin/users/list/active.json', {
        show_emails: true, page: page + 1
      })
      if (newUsers.length === 0) {
        break
      }
      _.each(newUsers, user => {
        if (user.id <= 0 || user.admin) {
          return
        }
        expect(emailValidator.validate(user.email)).to.be.true()
        if (emailAddresses.parseOneAddress(user.email).domain !== 'illinois.edu') {
          return
        }
        discoursePeople[user.email] = user
      })
    }
    return discoursePeople
  }

  /*
   * Create new users.
   */
  let discoursePeople = await getAllUsers()
  log.debug(`Retrieved ${_.keys(discoursePeople).length} users`)
  let create = _.difference(_.keys(existingPeople), _.keys(discoursePeople))
  if (create.length > 0) {
    log.debug(`Creating ${create.length}`)
    let createUsers = async create => {
      for (let user of _.values(_.pick(existingPeople, create))) {
        await callDiscourseAPI('post', 'users', null, {
          name: user.name.full,
          email: user.email,
          username: emailAddresses.parseOneAddress(user.email).local,
          password: passwordGenerator.generatePassword(passwordOptions),
          active: 1,
          approved: 1
        })
      }
    }
    await createUsers(create)

    discoursePeople = await getAllUsers()
    create = _.difference(_.keys(existingPeople), _.keys(discoursePeople))
    expect(create).to.have.lengthOf(0)
  }

  /*
   * Suspend users that have left.
   */
  let activeDiscoursePeople = _.pickBy(discoursePeople, user => {
    return !user.suspended
  })
  log.debug(`${_.keys(activeDiscoursePeople).length} are active`)
  let suspend = _.difference(_.keys(activeDiscoursePeople), _.keys(existingPeople))
  if (suspend.length > 0) {
    log.debug(`Suspending ${suspend.length}`)
    let suspendUsers = async suspend => {
      for (let user of _.values(_.pick(discoursePeople, suspend))) {
        await callDiscourseAPI('post', `admin/users/${user.id}/log_out`, null, {})
        await callDiscourseAPI('delete', `session/${user.username}`, null, {})
        if (user.moderator) {
          await callDiscourseAPI('put', `admin/users/${user.id}/revoke_moderation`)
        }
        await callDiscourseAPI('put', `admin/users/${user.id}/suspend`, null, {
          suspend_until: '3017-10-19 08:00',
          reason: 'No Longer In CS 125'
        })
      }
    }
    await suspendUsers(suspend)

    discoursePeople = await getAllUsers()
    activeDiscoursePeople = _.pickBy(discoursePeople, user => {
      return !user.suspended
    })
    suspend = _.difference(_.keys(activeDiscoursePeople), _.keys(existingPeople))
    expect(suspend).to.have.lengthOf(0)
  }

  /*
   * Reactivate suspended users.
   */
  let reactivate = _.difference(_.keys(existingPeople), _.keys(activeDiscoursePeople))
  if (reactivate.length > 0) {
    log.debug(`Reactivating ${reactivate.length}`)
    let reactivateUsers = async reactivate => {
      for (let user of _.values(_.pick(discoursePeople, reactivate))) {
        await callDiscourseAPI('put', `admin/users/${user.id}/unsuspend`, null, {})
      }
    }
    await reactivateUsers(reactivate)

    discoursePeople = await getAllUsers()
    activeDiscoursePeople = _.pickBy(discoursePeople, user => {
      return !user.suspended
    })
    reactivate = _.difference(_.keys(existingPeople), _.keys(activeDiscoursePeople))
    expect(reactivate).to.have.lengthOf(0)
  }

  /*
  for (let user of _.values(activeDiscoursePeople)) {
    await callDiscourseAPI('delete', `session/${ user.username }`, null, {})
  }
  */

  /*
   * Set up moderators properly
   */
  let discourseModerators = _.pickBy(discoursePeople, user => {
    return user.moderator
  })
  log.debug(`Forum has ${_.keys(discourseModerators).length} moderators`)
  let missingModerators = _.difference(_.keys(moderators), _.keys(discourseModerators))
  if (missingModerators.length > 0) {
    log.debug(`Adding ${missingModerators.length} moderators`)
    let addModerators = async moderators => {
      for (let user of _.values(_.pick(discoursePeople, moderators))) {
        await callDiscourseAPI('put', `admin/users/${user.id}/grant_moderation`)
      }
    }
    await addModerators(missingModerators)
  }
  let extraModerators = _.difference(_.keys(discourseModerators), _.keys(moderators))
  if (extraModerators.length > 0) {
    log.debug(`Removing ${extraModerators.length} moderators`)
    let removeModerators = async moderators => {
      for (let user of _.values(_.pick(discoursePeople, moderators))) {
        await callDiscourseAPI('put', `admin/users/${user.id}/revoke_moderation`)
      }
    }
    await removeModerators(extraModerators)
  }
  if (missingModerators.length > 0 || extraModerators > 0) {
    discoursePeople = await getAllUsers()
    discourseModerators = _.pickBy(discoursePeople, user => {
      return user.moderator
    })
    missingModerators = _.difference(_.keys(moderators), _.keys(discourseModerators))
    extraModerators = _.difference(_.keys(discourseModerators), _.keys(moderators))
    expect(missingModerators).to.have.lengthOf(0)
    expect(extraModerators).to.have.lengthOf(0)
  }

  await callDiscourseAPI('put', 'admin/site_settings/enable_local_logins', null, {
    enable_local_logins: false
  })
}

async function best (config) {
  /*
   * Update bestGrades to reflect staff and active students.
   */

  let client = await mongo.connect(config.secrets.mongo)
  let database = client.db(config.database)

  let allPeople = await getAllPeople(database.collection('people'))
  let bestGrades = database.collection('bestGrades')

  for (let person of _.values(allPeople)) {
    let data = {
      gender: person.gender,
      level: person.level,
      year: person.year,
      admitted: person.admitted,
      college: person.college,
      major: person.major
    }
    if (!person.active) {
      data.left = person.state.updated
    }
    if (person.survey) {
      data.survey = person.survey
    }
    await bestGrades.update({
      email: person.email
    }, {
      $set: {
        staff: person.staff, active: person.active, data
      }
    })
  }

  client.close()
}

let callTable = {
  reset, counter, state, staff
}

let argv = require('minimist')(process.argv.slice(2))
let config = _.extend(
  jsYAML.safeLoad(fs.readFileSync('config.yaml', 'utf8')),
  jsYAML.safeLoad(fs.readFileSync('secrets.yaml', 'utf8')),
  argv
)
let PrettyStream = require('bunyan-prettystream')
let prettyStream = new PrettyStream()
prettyStream.pipe(process.stdout)
if (config.debug) {
  log.addStream({
    type: 'raw',
    stream: prettyStream,
    level: 'debug'
  })
} else {
  log.addStream({
    type: 'raw',
    stream: prettyStream,
    level: 'warn'
  })
}
log.debug(_.omit(config, 'secrets'))
expect(config).to.not.have.property('counter')

let queue = asyncLib.queue((unused, callback) => {
  mongo.connect(config.secrets.mongo).then(client => {
    config.client = client
    config.database = client.db(config.database)
  }).then(() => {
    reset(config)
  }).then(() => {
    counter(config)
  }).then(() => {
    state(config)
  }).then(() => {
    people(config)
  }).then(() => {
    mailman(config)
  }).then(() => {
    discourse(config)
  }).then(() => {
    best(config)
  }).catch(err => {
    log.fatal(err)
  }).then(() => {
    if (config.client) {
      config.client.close()
    }
  })
  callback()
}, 1)

if (argv._.length === 0 && argv.oneshot) {
  queue.push({})
} else if (argv._.length !== 0) {
  mongo.connect(config.secrets.mongo).then(client => {
    config.client = client
    config.database = client.db(config.database)
    let currentPromise = counter(config)
    _.each(argv._, command => {
      currentPromise = currentPromise.then(() => {
        return callTable[command](config)
      })
    })
    return currentPromise
  }).then(() => {
    process.exit(0)
  }).catch(err => {
    throw err
  }).then(() => {
    if (config.client) {
      config.client.close()
    }
  })
} else {
  let CronJob = require('cron').CronJob
  let job = new CronJob('0 0 * * * *', async () => { // eslint-disable-line no-unused-vars
    queue.push({})
  }, null, true, 'America/Chicago')
  queue.push({})
}

process.on('unhandledRejection', (reason, promise) => {
  console.log(reason.stack || reason)
})

// vim: ts=2:sw=2:et:ft=javascript
