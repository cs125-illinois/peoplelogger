'use strict'

const _ = require('lodash')
const tmp = require('tmp')
const emailAddresses = require('email-addresses')
const fs = require('fs')
const childProcess = require('child_process')
const googleSpreadsheetToJSON = require('google-spreadsheet-to-json')
const chai = require('chai')
const expect = chai.expect
chai.use(require('dirty-chai'))
const emailValidator = require('email-validator')
const stringHash = require('string-hash')
const base64JS = require('base64-js')
const imageType = require('image-type')
const imageSize = require('image-size')
const resizeImg = require('resize-img')
const deepDiff = require('deep-diff').diff
const state = require('./state')

const got = require('got')
const getGravatar = require('gravatar')

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

  config.log.debug(`Running ${addCommand}`)
  try {
    childProcess.execSync(addCommand, options)
    fs.unlinkSync(configFile.name)
  } catch (err) {
    config.log.warn(err)
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

  config.log.debug(`Running ${getCommand}`)
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
  config.log.debug(`Saw ${_.keys(currentPeople).length} people`)

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
      image: person.image,
      left: false
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
  config.log.debug(`${_.keys(existingPhotos).length} existing photos`)

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
        thumbnail,
        active: true
      })
      bulkPhotos.find({
        email: person.email,
        _id: { $ne: imageHash }
      }).update({
        $set: {
          active: false
        }
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

const recordIgnoreKeys = [ 'state', '_id' ]
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
  config.log.debug(`${semester} ${type}: ${changes.left.length} left, ${changes.joined.length} joined, ${changes.same.length} same`)
  if (_.keys(existing).length > 0) {
    expect(changes.left.length).to.not.equal(_.keys(existing).length)
  }

  for (let email of changes.joined) {
    let person = current[email]
    expect(person.semester).to.equal(semester)
    bulkChanges.insert({
      type: 'joined',
      email,
      state: config.state,
      semester,
      person
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

    let existingPerson = _.omit(existing[email], ...recordIgnoreKeys)
    let currentPerson = _.omit(person, ...recordIgnoreKeys)

    let personDiff = deepDiff(existingPerson, currentPerson)
    if (personDiff !== undefined) {
      bulkChanges.insert({
        type: 'change',
        email: email,
        state: config.state,
        diff: personDiff,
        semester
      })
    }
  }

  bulkChanges.find({
    type: 'counter',
    semester,
    'state.counter': config.state.counter
  }).upsert().replaceOne({ type: 'counter', semester, state: config.state })
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
  return _(await database.collection('people').find({ semester }).toArray()).keyBy('email').value()
}

async function getAllPeople (database) {
  return _(await database.collection('people').find({}).toArray()).map(person => {
    return _.omit(person, '_id')
  }).keyBy(person => {
    return `${person.email}_${person.semester}`
  }).value()
}

async function addGravatar (config, people) {
  let distinctPeople = _.keyBy(people, 'email')
  expect(_.keys(distinctPeople).length).to.equal(_.keys(people).length)

  config.log.debug(`Updating Gravatars (takes a while)`)
  for (let person of _.values(distinctPeople)) {
    const url = getGravatar.url(person.email, { s: '460', d: '404' }, false)
    let hasGravatar
    try {
      await got.head(url)
      hasGravatar = true
    } catch (err) {
      if (err.statusCode === 404) {
        hasGravatar = false
      } else {
        config.log.warn(`${err.statusCode} fetching Gravatar for ${person.email}`)
      }
    }
    if (hasGravatar !== undefined) {
      person.hasGravatar = hasGravatar
    }
  }
}

async function addLabs (config, people, currentSemester) {
  const persons = await googleSpreadsheetToJSON({
    spreadsheetId: config.semesters[currentSemester].sheets.labs,
    credentials: config.secrets.google,
    propertyMode: 'none',
    worksheet: 'Form Responses 1'
  })

  _.each(people, person => {
    delete(person.labs)
  })

  for (let person of persons) {
    const email = person['Email Address']
    expect(email).to.be.ok()
    if (!(email in people)) {
      log.warn(`${ email } signed up for sections in ${ currentSemester } but missing from people`)
      continue
    }
    if (!(person['Sections'])) {
      continue
    }
    people[email].labs = person['Sections'].split(',')
    expect(people[email].labs).to.be.ok()
  }
  _.each(config.semesters[currentSemester].manualSectionAssignments, (assignments, email) => {
    expect(people).to.have.property(email)
    people[email].labs = _.concat(people[email].labs || [], assignments)
  })

  return people
}

function netIDsToEmails (netIDs) {
  return _.map(netIDs, netID => {
    return `${ netID.trim() }@illinois.edu`
  })
}
function dayToIndex (day) {
  switch (day) {
    case 'Sunday':
      return 0
    case 'Monday':
      return 1
    case 'Tuesday':
      return 2
    case 'Wednesday':
      return 3
    case 'Thursday':
      return 4
    case 'Friday':
      return 5
    case 'Saturday':
      return 6
    default:
      expect.fail(`Day ${ day } didn't match switch statement`)
  }
}
async function addOfficeHours (config, people, currentSemester) {

  if (!currentSemester) {
    const currentSemesters = await state.getActiveSemesters(config.database, config.people.startLoggingDaysBefore, config.people.endLoggingDaysAfter)
    expect(currentSemesters.length).to.be.within(0, 1)
    currentSemester = currentSemesters[0]
  }
  if (!currentSemester) {
    return
  }

  if (!people) {
    people = _.pickBy(await getSemesterPeople(config.database, currentSemester), person => {
      return person.role === 'TA' || person.role === 'assistant'
    })
  }

  _.each(people, person => {
    delete(person.officeHours)
  })

  const officeHours = await googleSpreadsheetToJSON({
    spreadsheetId: config.semesters[currentSemester].sheets.officeHours,
    credentials: config.secrets.google,
    propertyMode: 'none',
    worksheet: 'Weekly Schedule'
  })
  _.each(officeHours, officeHour => {
    let TAs = []
    try {
      TAs = _.filter(netIDsToEmails(officeHour.TA.split(',')), email => {
        if (email !== "—@illinois.edu" && !(email in people)) {
          config.log.warn(`${ email } signed up for office hours but not on staff`)
        }
        return email in people
      })
    } catch (err) { }
    let assistants = []
    try {
      assistants = _.filter(netIDsToEmails(officeHour.Assistants.split(',')), email => {
        if (email !== "—@illinois.edu" && !(email in people)) {
          config.log.warn(`${ email } signed up for office hours but not on staff`)
        }
        return email in people
      })
    } catch (err) { }
    if (TAs.length + assistants.length === 0) {
      config.log.debug('Ignoring', officeHour)
      return
    }
    const officeHourInfo = {
      location: officeHour.Location,
      day: officeHour.Day,
      start: `${ Math.round(officeHour.Start * 24) }:00`,
      end: `${ Math.round(officeHour.End * 24) }:00`,
      sortStart: officeHour.Start
    }
    _.each(_.union(TAs, assistants), email => {
      let person = people[email]
      if (!person.officeHours) {
        person.officeHours = []
      }
      person.officeHours.push(officeHourInfo)
    })
  })

  _.each(people, person => {
    if (!person.officeHours) {
      return
    }
    person.sawOfficeHours = config.runTime.toDate()
    person.officeHours = _(person.officeHours).sortBy(officeHourInfo => {
      return dayToIndex(officeHourInfo.day) + officeHourInfo.sortStart
    }).map(officeHourInfo => {
      return _.omit(officeHourInfo, 'sortStart')
    }).value()
  })
}

async function staff (config) {
  let peopleCollection = config.database.collection('people')

  const currentSemesters = await state.getActiveSemesters(config.database, config.people.startLoggingDaysBefore, config.people.endLoggingDaysAfter)

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

    currentStaff = _.pickBy(currentStaff, person => {
      let left = (staff.all.indexOf(person.email) === -1)
      if (left) {
        config.log.debug(`${person.email} left the course staff`)
      }
      return !left
    })
    expect(_.keys(currentStaff).length).to.equal(staff.all.length)

    await addPhotos(config, _.values(currentStaff))

    if (!config.skipGravatars) {
      await addGravatar(config, _.values(currentStaff))
    }

    await addLabs(config, currentStaff, currentSemester)

    await addOfficeHours(config, currentStaff, currentSemester)

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
      let active = false
      if (person.labs && person.labs.length > 0) {
        active = true
      } else if (person.officeHours && person.officeHours.length > 0) {
        active = true
      } else if (person.sawOfficeHours && moment(person.sawOfficeHours).isAfter(config.runTime.subtract(config.people.officeHourGracePeriodDays, 'days'))) {
        active = true
      }
      person.active = active && ('info' in person)
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
        left: false,
        role: 'instructor',
        hasGravatar: true
      })
    }
    await bulkPeople.execute()
  }
}

async function addAllowed (config, currentStudents, currentSemester) {
  let peopleCollection = config.database.collection('people')
  let photoCollection = config.database.collection('photos')
  let bulkPhotos = photoCollection.initializeUnorderedBulkOp()

  if (!currentStudents) {
    currentSemester = (await state.getActiveSemesters(config.database, config.people.startLoggingDaysBefore, config.people.endLoggingDaysAfter))[0]
    currentStudents = _.keyBy(await peopleCollection.find({
      instructor: false, student: true, semester: currentSemester
    }).toArray(), 'email')
  }

  let existingStaff = _.keyBy(await peopleCollection.find({
    instructor: false, staff: true, semester: currentSemester
  }).toArray(), 'email')
  let staffByLab = {}
  _.each(existingStaff, staffMember => {
    if (!staffMember.labs || staffMember.labs.length === 0) {
      return
    }
    _.each(staffMember.labs, lab => {
      if (!(lab in staffByLab)) {
        staffByLab[lab] = {}
      }
      staffByLab[lab][staffMember.email] = true
    })
  })
  let allInstructors = _.map(await peopleCollection.find({
    instructor: true, semester: currentSemester
  }).toArray(), 'email')
  let doBulk = false
  _.each(currentStudents, student => {
    let labStaff = []
    if (student.lab) {
      labStaff = _.keys(staffByLab[student.lab])
    }
    student.allowed = _.uniq([ ...allInstructors, ...labStaff ]).sort()
    doBulk = true
    bulkPhotos.find({
      email: student.email
    }).update({
      $set: {
        allowed: {
          [`${ currentSemester }`]: student.allowed
        }
      }
    })
  })
  if (doBulk) {
    await bulkPhotos.execute()
  }
}

async function students (config) {
  let peopleCollection = config.database.collection('people')

  const currentSemesters = await state.getActiveSemesters(config.database, config.people.startLoggingDaysBefore, config.people.endLoggingDaysAfter)

  for (let currentSemester of currentSemesters) {
    let currentStudents = await getFromMyCS(config, currentSemester, {
      subject: config.subject,
      semester: config.semesters[currentSemester].name,
      number: config.number,
      secrets: config.secrets
    })

    await addPhotos(config, _.values(currentStudents))

    if (!config.skipGravatars) {
      await addGravatar(config, _.values(currentStudents))
    }

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
        config.log.warn(`${student.email} is not assigned to a lab section`)
      } else if (labs.length > 1) {
        config.log.warn(`${student.email} is assigned to multiple lab sections`)
      } else {
        student.lab = labs[0]
      }

      let lectures = _(student.sections).map('name').filter(name => {
        return name.startsWith(config.lecturePrefix)
      }).value()
      if (lectures.length === 0) {
        config.log.warn(`${student.email} is not assigned to a lecture`)
      } else if (lectures.length > 1) {
        config.log.warn(`${student.email} is assigned to multiple lectures`)
      } else {
        student.lecture = lectures[0]
      }

      delete (student.image)
    })

    await addAllowed(config, currentStudents, currentSemester)

    let existingStudents = _.keyBy(await peopleCollection.find({
      instructor: false, student: true, semester: currentSemester, active: true
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

module.exports = exports = {
  staff, students, getSemesterPeople, getAllSemesterPeople, getAllPeople, addOfficeHours, addAllowed
}

// vim: ts=2:sw=2:et:ft=javascript
