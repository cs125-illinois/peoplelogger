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

npmPath.setSync()

const reset = require('./lib/reset')
const counter = require('./lib/counter')
const state = require('./lib/state')

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
    fs.unlinkSync(configFile.name)
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
    fs.unlinkSync(configFile.name)
    return
  }
  try {
    var currentPeople = JSON.parse(childProcess.execSync(getCommand, options).toString())
    fs.unlinkSync(configFile.name)
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

    _.each(normalizedPerson, (value, key) => {
      if (value === undefined || value === null) {
        delete (normalizedPerson[key])
      }
    })

    return normalizedPerson
  }).keyBy('email').value()
}

/*
 * Example object from my.cs.illinois.edu:
 *
 * "Action": "",
 * "Admit Term": "Fall 2017",
 * "College": "Liberal Arts & Sciences",
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

const BLANK_PHOTO = 1758209682
async function addPhotos (config, people) {
  let photoCollection = config.database.collection('photos')
  let bulkPhotos = photoCollection.initializeUnorderedBulkOp()

  let existingPhotos = _.keyBy(await photoCollection.find({}).project({
    _id: 1, email: 1
  }).toArray(), '_id')
  log.debug(`${_.keys(existingPhotos).length} existing photos`)

  let newCount = 0
  for (let person of people) {
    const imageHash = stringHash(person.image)
    if (imageHash === BLANK_PHOTO) {
      continue
    }
    if (existingPhotos[imageHash]) {
      expect(existingPhotos[imageHash].email).to.equal(person.email)
      person.imageID = imageHash
    } else {
      person.imageID = imageHash
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

      newCount++
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
      existingPhotos[imageHash] = {
        email: person.email
      }
    }
  }

  if (newCount > 0) {
    await bulkPhotos.execute()
  }
}

async function recordPeople (config, existing, current, semester, staff = false) {
  const type = staff ? 'Staff' : 'Students'
  let peopleCollection = config.database.collection('people')
  let bulkPeople = peopleCollection.initializeUnorderedBulkOp()
  let peopleCount = 0

  let changesCollection = config.database.collection('peopleChanges')
  let bulkChanges = changesCollection.initializeUnorderedBulkOp()

  let changes = {
    joined: _.difference(_.keys(current), _.keys(existing)),
    left: _.difference(_.keys(existing), _.keys(current)),
    same: _.intersection(_.keys(current), _.keys(existing))
  }
  log.debug(`${semester} ${type}: ${changes.left.length} left, ${changes.joined.length} joined, ${changes.same.length} same`)
  if (_.keys(existing).length > 0) {
    expect(changes.left.length).to.not.equal(_.keys(existing).length)
  }

  for (let email of changes.joined) {
    let person = current[email]
    person.left = false
    expect(person.semester).to.equal(semester)
    bulkChanges.insert({
      type: 'joined',
      email,
      state: config.state,
      semester
    })
    peopleCount++
    bulkPeople.find({
      _id: `${email}_${semester}`
    }).upsert().replaceOne(person)
  }

  for (let email of changes.left) {
    let person = existing[email]
    expect(person.semester).to.equal(semester)
    bulkChanges.insert({
      type: 'left',
      email,
      state: config.state,
      semester
    })
    peopleCount++
    bulkPeople.find({
      _id: `${email}_${semester}`
    }).update({
      $set: {
        active: false, left: true
      }
    })
  }

  for (let email of changes.same) {
    let person = current[email]
    peopleCount++
    bulkPeople.find({
      _id: `${email}_${semester}`
    }).replaceOne(person)

    let existingPerson = _.omit(existing[email], 'state', '_id')
    let currentPerson = _.omit(person, 'state')

    let personDiff = deepDiff(existingPerson, currentPerson)
    if (personDiff !== undefined) {
      bulkChanges.insert({
        type: 'change',
        email: email,
        state: config.state,
        diff: personDiff
      })
    }
    peopleCount++
    bulkPeople.find({
      _id: `${email}_${semester}`
    }).update({
      $set: {
        left: false
      }
    })
  }

  bulkChanges.insert({ type: 'counter', semester, state: config.state })
  await bulkChanges.execute()
  if (peopleCount > 0) {
    await bulkPeople.execute()
  }
}

async function getInfoFromSheet (config, info) {
  info.worksheet = info.worksheet !== undefined ? info.worksheet : [ 'Form Responses 1' ]
  info.email = info.email !== undefined ? info.email : 'Email Address'
  expect(info.worksheet.length).to.equal(1)
  expect(info.email).to.be.ok()

  let sheet = await googleSpreadsheetToJSON({
    spreadsheetId: info.sheet,
    credentials: config.secrets.google,
    propertyMode: 'none',
    worksheet: info.worksheet
  })
  expect(sheet.length).to.equal(1)
  sheet = sheet[0]

  return _(sheet).map(p => {
    let person = {
      email: p[info.email]
    }
    expect(person.email).to.be.ok()
    _.each(info.mapping, (to, from) => {
      if (p[from]) {
        person[to] = p[from]
      }
    })
    return person
  }).keyBy('email').value()
}

async function getSemesterPeople (database, semester) {
  return _(await database.collection('people').find({ semester, left: false }).toArray()).map(person => {
    return _.omit(person, '_id')
  }).keyBy('email').value()
}

async function getAllSemesterPeople (database, semester) {
  return _(await database.collection('people').find({ semester }).toArray()).map(person => {
    return _.omit(person, '_id')
  }).keyBy('email').value()
}

async function getAllPeople (database) {
  return _(await database.collection('people').find({}).toArray()).map(person => {
    return _.omit(person, '_id')
  }).keyBy(person => {
    return `${person.email}_${person.semester}`
  }).value()
}

async function staff (config) {
  let peopleCollection = config.database.collection('people')

  const currentSemesters = await getActiveSemesters(config.database, config.people.startLoggingDaysBefore, config.people.endLoggingDaysAfter)

  for (let currentSemester of currentSemesters) {
    let staff = {}
    let TAsAndCDs = await getEmailsFromSheet(config, config.semesters[currentSemester].sheets.staff, ['TAs', 'CDs'])
    staff.TAs = _(TAsAndCDs).pickBy(sheet => {
      return sheet === 'TAs'
    }).keys().value()
    staff.developers = _(TAsAndCDs).pickBy(sheet => {
      return sheet === 'CDs'
    }).keys().value()
    let CAs = await getEmailsFromSheet(config, config.semesters[currentSemester].sheets.CAs, ['Form Responses 1'], 'Email Address')
    staff.assistants = _.keys(CAs).filter(email => {
      return staff.developers.indexOf(email) === -1
    })
    staff.all = [ ...staff.TAs, ...staff.developers, ...staff.assistants ]

    const staffInfo = await getInfoFromSheet(config, {
      sheet: config.semesters[currentSemester].sheets.staffInfo,
      mapping: {
        'GitHub Username': 'github',
        'Smartphone OS': 'smartphone',
        'Apple ID Email': 'appleID',
        'Google Play Store Email': 'playStoreID'
      }
    })

    addStaffToMyCS(config, currentSemester, staff.all)

    let currentStaff = await getFromMyCS(config, currentSemester, {
      subject: config.subject,
      semester: config.semesters[currentSemester].name,
      number: config.semesters[currentSemester].staffCourse.number,
      sections: [ config.semesters[currentSemester].staffCourse.section ],
      secrets: config.secrets
    })

    expect(_.keys(currentStaff).length).to.equal(staff.all.length)

    await addPhotos(config, _.values(currentStaff))

    _.each(currentStaff, staffMember => {
      staffMember.semester = currentSemester
      staffMember.staff = true
      staffMember.student = false
      staffMember.active = false

      if (staffMember.email in staffInfo) {
        staffMember.info = staffInfo[staffMember.email]
      }

      delete (staffMember.image)
      delete (staffMember.sections)
      delete (staffMember.totalCredits)
    })
    _.each(staff.TAs, email => {
      expect(currentStaff).to.have.property(email)
      let person = currentStaff[email]
      expect(person).to.not.have.property('role')
      person.role = 'TA'
      person.active = true
    })
    _.each(staff.developers, email => {
      expect(currentStaff).to.have.property(email)
      let person = currentStaff[email]
      expect(person).to.not.have.property('role')
      person.role = 'developer'
      person.active = 'info' in person
    })
    _.each(staff.assistants, email => {
      expect(currentStaff).to.have.property(email)
      let person = currentStaff[email]
      expect(person).to.not.have.property('role')
      person.role = 'assistant'
    })

    let existingStaff = _.keyBy(await peopleCollection.find({
      instructor: false, staff: true, semester: currentSemester
    }).toArray(), 'email')
    await recordPeople(config, existingStaff, currentStaff, currentSemester, true)

    expect(config.semesters[currentSemester].instructors.length).to.be.at.least(1)
    let bulkPeople = peopleCollection.initializeUnorderedBulkOp()
    for (let instructor of config.semesters[currentSemester].instructors) {
      bulkPeople.find({
        _id: `${instructor.email}_${currentSemester}`
      }).upsert().replaceOne({
        email: instructor.email,
        name: {
          full: instructor.name
        },
        username: emailAddresses.parseOneAddress(instructor.email).local,
        instructor: true,
        staff: true,
        active: true,
        semester: currentSemester,
        left: false
      })
    }
    await bulkPeople.execute()
  }
}

async function students (config) {
  let peopleCollection = config.database.collection('people')

  const currentSemesters = await getActiveSemesters(config.database, config.people.startLoggingDaysBefore, config.people.endLoggingDaysAfter)

  for (let currentSemester of currentSemesters) {
    let currentStudents = await getFromMyCS(config, currentSemester, {
      subject: config.subject,
      semester: config.semesters[currentSemester].name,
      number: config.number,
      secrets: config.secrets
    })

    await addPhotos(config, _.values(currentStudents))

    _.each(currentStudents, student => {
      student.active = true
      student.semester = currentSemester
      student.staff = false
      student.student = true
      student.role = student.totalCredits > 0 ? 'student' : 'other'

      let labs = _(student.sections).map('name').filter(name => {
        return name.startsWith(config.labPrefix)
      }).value()
      if (labs.length === 0) {
        log.warn(`${student.email} is not assigned to a lab section`)
      } else if (labs.length > 1) {
        log.warn(`${student.email} is assigned to multiple lab sections`)
      } else {
        student.lab = labs[0]
      }

      let lectures = _(student.sections).map('name').filter(name => {
        return name.startsWith(config.lecturePrefix)
      }).value()
      if (lectures.length === 0) {
        log.warn(`${student.email} is not assigned to a lecture`)
      } else if (lectures.length > 1) {
        log.warn(`${student.email} is assigned to multiple lectures`)
      } else {
        student.lecture = lectures[0]
      }

      delete (student.image)
    })

    let existingStudents = _.keyBy(await peopleCollection.find({
      instructor: false, student: true, semester: currentSemester
    }).toArray(), 'email')
    await recordPeople(config, existingStudents, currentStudents, currentSemester)

    await peopleCollection.updateMany({
      semester: currentSemester,
      staff: false,
      'state.counter': { $eq: config.state.counter }
    }, {
      $set: { active: true }
    })
    await peopleCollection.updateMany({
      semester: currentSemester,
      staff: false,
      'state.counter': { $ne: config.state.counter }
    }, {
      $set: { active: false }
    })
  }
}

function doBreakdowns (people, breakdowns, enrollments) {
  _.each(_.keys(breakdowns), name => {
    enrollments[name] = {}
  })
  for (let person of people) {
    _.each(breakdowns, (determine, name) => {
      let value
      if (determine === true) {
        value = person[name]
      } else {
        value = determine(person, enrollments[name])
      }
      if (value === undefined) {
        log.warn(`Enrollment key ${name} missing from ${person}`)
      }
      if (!(value in enrollments[name])) {
        enrollments[name][value] = 0
      }
      enrollments[name][value]++
    })
  }
}

async function enrollment (config) {
  let enrollmentCollection = config.database.collection('enrollment')

  const currentSemesters = await getActiveSemesters(config.database, config.semesterStartsDaysBefore, config.semesterEndsDaysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  if (currentSemesters.length === 0) {
    return
  }
  const currentSemester = currentSemesters[0]
  const people = await getAllSemesterPeople(config.database, currentSemester)

  let enrollments = {
    activeStudents: {},
    inactiveStudents: {},
    staff: {},
    semester: currentSemester,
    state: config.state
  }

  const studentBreakdowns = {
    'admitted': true,
    'college': true,
    'gender': true,
    'level': true,
    'major': true,
    'year': true,
    'CS': ({ major }) => {
      if (major === 'Computer Science') {
        return 'CS'
      } else if (major === 'Computer Engineering') {
        return 'CE'
      } else if (major.includes('Computer Science') || major.includes('Computer Sci')) {
        return 'CS+X'
      } else {
        return 'Other'
      }
    },
    'lab': true,
    'lecture': true
  }

  const activeStudents = _(people).pickBy(({ active, role }) => { return active && role === 'student' }).values().value()
  enrollments.activeStudents.total = activeStudents.length
  doBreakdowns(activeStudents, studentBreakdowns, enrollments.activeStudents)
  const inActiveStudents = _(people).pickBy(({ active, role }) => { return !active && role === 'student' }).values().value()
  enrollments.inactiveStudents.total = inActiveStudents.length
  doBreakdowns(inActiveStudents, studentBreakdowns, enrollments.inactiveStudents)

  const staffBreakdowns = {
    'role': true,
    'admitted': true,
    'college': true,
    'gender': true,
    'level': true,
    'major': true,
    'year': true,
    'CS': ({ major }) => {
      if (major === 'Computer Science') {
        return 'CS'
      } else if (major === 'Computer Engineering') {
        return 'CE'
      } else if (major.includes('Computer Science') || major.includes('Computer Sci')) {
        return 'CS+X'
      } else {
        return 'Other'
      }
    },
    'sections': ({ sections }, sectionCounts) => {
      if (!sections) {
        return
      }
      for (let section of sections) {
        if (!(section in sectionCounts)) {
          sectionCounts[section] = 0
        }
        sectionCounts[section]++
      }
    }
  }

  const staff = _(people).pickBy(({ active, staff, instructor }) => { return active && staff && !instructor }).values().value()
  enrollments.staff.total = staff.length
  doBreakdowns(staff, staffBreakdowns, enrollments.staff)

  await enrollmentCollection.insertOne(enrollments)
}

function syncList (name, people, memberFilter, moderatorFilter = null, dryRun = false) {
  const instructors = _(people).filter(person => {
    return person.instructor
  }).value()
  expect(instructors.length).to.be.at.least(1)
  const members = _(people).filter(memberFilter).concat(instructors).uniq().value()
  if (members.length === instructors.length) {
    log.warn(`${name} has no members`)
    return
  }
  let moderators
  if (moderatorFilter === null) {
    moderators = members
  } else if (moderatorFilter === true) {
    moderators = instructors
  } else {
    moderators = _(people).filter(memberFilter).filter(moderatorFilter).concat(instructors).uniq().value()
  }
  moderators = _.map(moderators, 'email')
  expect(moderators.length).to.be.at.least(instructors.length)

  let membersFile = tmp.fileSync().name
  fs.writeFileSync(membersFile, _.map(members, p => {
    return `"${p.name.full}" <${p.email}>`
  }).join('\n'))

  log.debug(`${name} has ${_.keys(members).length} members`)
  let command
  command = `sudo remove_members -a -n -N ${name} 2>/dev/null`
  dryRun ? log.debug(command) : childProcess.execSync(command)
  command = `sudo add_members -w n -a n -r ${membersFile} ${name} 2>/dev/null`
  dryRun ? log.debug(command) : childProcess.execSync(command)
  command = `sudo withlist -r set_mod ${name} -s -a 2>/dev/null`
  dryRun ? log.debug(command) : childProcess.execSync(command)
  command = `sudo withlist -r set_mod ${name} -u ${moderators.join(' ')}  2>/dev/null`
  dryRun ? log.debug(command) : childProcess.execSync(command)

  fs.unlinkSync(membersFile)
}

async function mailman (config) {
  const dryRun = ip.address() !== config.mailServer
  if (dryRun) {
    log.warn(`Mailman dry run since we are not on the mail server`)
  }
  const currentSemesters = await getActiveSemesters(config.database, config.semesterStartsDaysBefore, config.semesterEndsDaysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  if (currentSemesters.length === 0) {
    return
  }
  const currentSemester = currentSemesters[0]
  const people = await getSemesterPeople(config.database, currentSemester)

  syncList(
    `staff`,
    people,
    ({ role }) => { return role === 'TA' },
    null,
    dryRun
  )
  syncList(
    `developers`,
    people,
    ({ role, active }) => { return role === 'developer' && active },
    null,
    dryRun
  )
  syncList(
    `prospective-developers`,
    people,
    ({ role }) => { return role === 'developer' },
    true,
    dryRun
  )
  syncList(
    `assistants`,
    people,
    ({ role, active }) => { return role === 'assistant' && active },
    true,
    dryRun
  )
  syncList(
    `prospective-assistants`,
    people,
    ({ role }) => { return role === 'assistant' },
    true,
    dryRun
  )
  syncList(
    `students`,
    people,
    ({ active }) => { return active },
    ({ role, active }) => { return role === 'TA' && active },
    dryRun
  )
}

async function people (config) {
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
}

async function callDiscourseAPI (config, request) {
  let discourseClient = requestJSON.createClient(config.discourseURL)

  let { verb, path, query, body } = request
  query = query !== undefined ? query : {}
  query = {
    api_username: config.secrets.discourse.username,
    api_key: config.secrets.discourse.key,
    ...query
  }
  path += '?' + queryString.stringify(query)
  log.debug(path)

  for (let retry = 0; retry < 15; retry++) {
    if (verb === 'get') {
      var result = await discourseClient.get(path)
    } else if (verb === 'put' || verb === 'post') {
      var result = await discourseClient[verb](path, body)
    } else if (verb === 'delete') {
      discourse.headers['X-Requested-With'] = 'XMLHTTPRequest'
      var result = await discourseClient.delete(path)
    }
    if (result.res.statusCode === 429 || result.res.statusCode === 500) {
      log.warn(`Sleeping for ${result.res.statusCode}`)
      sleep.sleep(5)
    } else {
      break
    }
  }
  expect(result.res.statusCode).to.equal(200)
  return result.body
}

async function updateDiscourseUsers (config) {
  let peopleCollection = config.database.collection('people')
  let bulkPeople = peopleCollection.initializeUnorderedBulkOp()
  let discourseCollection = config.database.collection('discourse')
  let bulkDiscourse = discourseCollection.initializeUnorderedBulkOp()

  let allEmails = _(await config.database.collection('people').find({}).toArray()).map('email').uniq().value()

  const currentSemesters = await getActiveSemesters(config.database, config.semesterStartsDaysBefore, config.semesterEndsDaysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  let semesterEmails = []
  if (currentSemesters.length === 1) {
    semesterEmails = _(await config.database.collection('people').find({ semester: currentSemesters[0] }).toArray()).map('email').uniq().value()
  }

  let discourseUsers = {}, doPeople = false, doDiscourse = false
  for (let page = 0; ; page++) {
    let newUsers = await callDiscourseAPI(config, {
      verb: 'get',
      path: 'admin/users/list/active.json',
      query: {
        show_emails: true, page: page + 1
      }
    })
    if (newUsers.length === 0) {
      break
    }
    _.each(newUsers, user => {
      if (user.id <= 0 || user.admin || allEmails.indexOf(user.email) === -1) {
        return
      }
      expect(emailValidator.validate(user.email)).to.be.true()
      if (emailAddresses.parseOneAddress(user.email).domain !== 'illinois.edu') {
        return
      }
      discourseUsers[user.email] = user
    })
  }
  log.debug(`Found ${_.keys(discourseUsers).length} Discourse users`)

  for (let user of _.values(discourseUsers)) {
    let detailedUserInfo = await callDiscourseAPI(config, {
      verb: 'get',
      path: `admin/users/${user.id}.json`
    })
    detailedUserInfo.groupIDs = _.map(detailedUserInfo.groups, 'id')
    detailedUserInfo.primaryGroupID = _(detailedUserInfo.groups).filter(group => {
      return group.primary_group
    }).map('id').value()[0]
    delete (detailedUserInfo.groups)
    doPeople = true
    bulkPeople.find({ email: user.email }).update({
      $set: {
        discourseUser: detailedUserInfo
      }
    })
    if (semesterEmails.indexOf(user.email) !== -1) {
      doDiscourse = true
      bulkDiscourse.insert({
        state: config.state,
        ...detailedUserInfo
      })
    }
  }
  if (doPeople) {
    await bulkPeople.execute()
  }
  if (doDiscourse) {
    await bulkDiscourse.execute()
  }
}

async function getAllDiscourseGroups (config) {
  let discourseGroups = {}
  for (let page = 0; ; page++) {
    let newGroups = await callDiscourseAPI(config, {
      verb: 'get',
      path: 'groups.json',
      query: {
        page: page + 0
      }
    })
    if (newGroups.groups.length === 0) {
      break
    }
    _.each(newGroups.groups, group => {
      discourseGroups[group.name] = group
    })
  }
  log.debug(`Found ${_.keys(discourseGroups).length} Discourse groups`)

  return discourseGroups
}

const PASSWORD_OPTIONS = { minimumLength: 10, maximumLength: 12 }
async function createDiscourseUser (config, person) {
  let peopleCollection = config.database.collection('people')
  let discourseCollection = config.database.collection('discourse')

  log.debug(`Creating ${person.email}`)

  const newUser = await callDiscourseAPI(config, {
    verb: 'post',
    path: 'users',
    body: {
      name: person.name.full,
      email: person.email,
      username: emailAddresses.parseOneAddress(person.email).local,
      password: passwordGenerator.generatePassword(PASSWORD_OPTIONS),
      active: 1,
      approved: 1
    }
  })

  let detailedUserInfo = await callDiscourseAPI(config, {
    verb: 'get',
    path: `admin/users/${newUser.user_id}.json`
  })
  detailedUserInfo.groupIDs = _.map(detailedUserInfo.groups, 'id')
  detailedUserInfo.primaryGroupID = _(detailedUserInfo.groups).filter(group => {
    return group.primary_group
  }).map('id').value()[0]

  await peopleCollection.updateMany({ email: person.email }, {
    $set: {
      discourseUser: detailedUserInfo
    }
  })
}

async function syncUserGroups (config, user, discourseGroups, autoGroups, userGroups, userPrimaryGroup) {
  expect(userGroups.indexOf(userPrimaryGroup)).to.not.equal(-1)

  const shouldBeIn = _(autoGroups).filter(name => {
    return userGroups.indexOf(name) !== -1
  }).map(name => {
    return discourseGroups[name].id
  }).value()
  const shouldNotBeIn = _(autoGroups).filter(name => {
    return userGroups.indexOf(name) === -1
  }).map(name => {
    return discourseGroups[name].id
  }).value()
  expect(shouldBeIn.length + shouldNotBeIn.length).to.equal(autoGroups.length)

  /*
  expect(discourseGroups).to.have.property(userPrimaryGroup)
  await callDiscourseAPI(config, {
    verb: 'put',
    path: `/admin/users/{ user.id }/primary_group`,
    body: {
      primary_group_id: discourseGroups[userPrimaryGroup].id
    }
  })
  */
}

async function discourse (config) {
  await callDiscourseAPI(config, {
    verb: 'put',
    path: 'admin/site_settings/enable_local_logins',
    body: {
      enable_local_logins: true
    }
  })

  let people = _(await getAllPeople(config.database)).pickBy(person => {
    return !person.instructor
  }).values().keyBy('email').value()
  for (let person of _.values(people)) {
    if (!(person.discourseUser)) {
      await createDiscourseUser(config, person)
    }
  }
  people = _(await getAllPeople(config.database)).pickBy(person => {
    return !person.instructor
  }).values().keyBy('email').value()
  expect(_.filter(people, person => { return !person.discourseUser }).length).to.equal(0)

  const groups = await getAllDiscourseGroups(config)

  const currentSemesters = await getActiveSemesters(config.database)
  expect(currentSemesters.length).to.be.within(0, 1)
  const currentSemester = currentSemesters.length === 1 ? currentSemesters[0] : undefined

  let autoGroups = []
  let userGroups = {}, primaryGroup = {}
  for (let person of _.values(people)) {
    userGroups[person.email] = []
  }
  _.each(config.semesters, (semesterConfig, semester) => {
    const semesterPeople = _.filter(people, person => {
      return person.semester === semester
    })
    const students = _(semesterPeople).values().filter(person => {
      return person.role === 'student' && person.active
    }).map('email').value()
    const TAs = _(semesterPeople).values().filter(person => {
      return person.role === 'TA'
    }).map('email').value()
    const CAs = _(semesterPeople).values().filter(person => {
      return person.role === 'assistant' && person.active
    }).map('email').value()
    const developers = _(semesterPeople).values().filter(person => {
      return person.role === 'developer'
    }).map('email').value()
    const inactive = _(semesterPeople).values().filter(person => {
      return students.indexOf(person.email) === -1 &&
        TAs.indexOf(person.email) === -1 &&
        CAs.indexOf(person.email) === -1 &&
        developers.indexOf(person.email) === -1
    }).map('email').value()
    log.debug(`${semester} has ${students.length} active students, ${TAs.length} TAs, ${CAs.length} active CAs, ${developers.length} developers, and ${inactive.length} inactive users`)
    expect(students.length + TAs.length + CAs.length + developers.length + inactive.length).to.equal(semesterPeople.length)

    autoGroups = autoGroups.concat([
      `${semester}`,
      `${semester}-TAs`,
      `${semester}-CAs`,
      `${semester}-CDs`,
      `${semester}-Inactive`
    ])

    _.each(students, email => {
      userGroups[email].push(`${semester}`)
      primaryGroup[email] = `${semester}`
    })
    _.each(TAs, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-TAs`)
      primaryGroup[email] = `${semester}-TAs`
      userGroups[email].push(`${semester}-Staff`)
    })
    _.each(CAs, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-CAs`)
      primaryGroup[email] = `${semester}-CAs`
      userGroups[email].push(`${semester}-Staff`)
    })
    _.each(developers, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-CDs`)
      primaryGroup[email] = `${semester}-CDs`
      userGroups[email].push(`${semester}-Staff`)
    })
    _.each(inactive, email => {
      userGroups[email].push(`${semester}-Inactive`)
      primaryGroup[email] = `${semester}-Inactive`
    })
  })

  for (let group of autoGroups) {
    expect(groups).to.have.property(group)
    const groupInfo = groups[group]
    expect(groupInfo.automatic).to.equal(false)
  }

  for (let email of _.keys(discourseUsers)) {
    if (!(email in userGroups)) {
      userGroups[email] = [ 'Fall2017' ]
      primaryGroup[email] = 'Fall2017'
    }
    await syncUserGroups(config, discourseUsers[email], groups, autoGroups, userGroups[email], primaryGroup[email])
  }

  await callDiscourseAPI(config, {
    verb: 'put',
    path: 'admin/site_settings/enable_local_logins',
    body: {
      enable_local_logins: false
    }
  })

  return

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
  reset, state, staff, students, enrollment, mailman, updateDiscourseUsers, discourse
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
  config.runTime = moment()
  config.log = log

  mongo.connect(config.secrets.mongo, { useNewUrlParser: true }).then(client => {
    config.client = client
    config.database = client.db(config.databaseName)
  }).then(() => {
    return counter.counter(config)
  }).then(() => {
    return state.state(config)
  }).then(() => {
    return staff(config)
  }).then(() => {
    return students(config)
  }).then(() => {
    return enrollment(config)
  }).then(() => {
    return mailman(config)
  }).then(() => {
    if (config.client) {
      config.client.close()
    }
  })
  /*
    .then(() => {
    discourse(config)
  }).then(() => {
    best(config)
  }).catch(err => {
    log.fatal(err)
  })
  */
  callback()
}, 1)

if (argv._.length === 0 && argv.oneshot) {
  queue.push({})
} else if (argv._.length !== 0) {
  config.log = log
  config.runTime = moment()

  mongo.connect(config.secrets.mongo, { useNewUrlParser: true }).then(client => {
    config.client = client
    config.database = client.db(config.databaseName)
    let currentPromise = counter.counter(config)
    _.each(argv._, command => {
      currentPromise = currentPromise.then(() => {
        return callTable[command][command](config)
      }).catch(err => {
        try {
          config.client.close()
        } catch (err) { }
        console.error(err.stack)
        process.exit(-1)
      })
    })
    return currentPromise
  }).then(config => {
    try {
      config.client.close()
      delete (config.client)
    } catch (err) { }
    process.exit(0)
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
