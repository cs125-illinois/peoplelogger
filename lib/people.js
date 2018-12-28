'use strict'

const _ = require('lodash')
const jsYAML = require('js-yaml')
const emailAddresses = require('email-addresses')
const fs = require('fs')
const googleSpreadsheetToJSON = require('google-spreadsheet-to-json')
const chai = require('chai')
const expect = chai.expect
chai.use(require('dirty-chai'))
const deepDiff = require('deep-diff').diff
const state = require('./state')
const moment = require('moment-timezone')
const LDAP = require('promised-ldap')

const got = require('got')
const getGravatar = require('gravatar')

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

const peopleDN = 'OU=People,DC=AD,DC=UILLINOIS,DC=EDU'
async function getPeopleFromAD (config, IDs) {
  const client = new LDAP({ url: 'ldap://ad.uillinois.edu/' })
  const people = {}
  return client.starttls({}, []).then(async () => {
    await client.bind(config.secrets.AD.username, config.secrets.AD.password)
    for (const ID of IDs) {
      const netID = ID.replace('@illinois.edu', '')
      const results = await client.search(peopleDN, {
        filter: `(cn=${netID})`, scope: 'sub'
      })
      expect(results.entries.length).to.equal(1)
      const result = results.entries[0].object
      const { givenName: first, sn: last,
        mail: email,
        uiucEduStudentCollegeName: college,
        uiucEduStudentLevelCode: level,
        uiucEduStudentMajorName: major,
        cn: username,
        uiucEduUIN: UID,
        memberOf
      } = result
      expect(people).to.not.have.property(email)
      people[email] = {
        email,
        name: {
          first, last, full: `${first} ${last}`
        },
        college,
        level,
        major,
        username,
        ID: UID,
        memberOf,
        instructor: false,
        state: config.state,
        left: false
      }
      _.each(people[email], (value, key) => {
        if (value === undefined) {
          people[email][key] = null
        }
      })
    }

    client.unbind()
    return people
  })
}

const courseDN = 'OU=Sections,OU=Class Rosters,OU=Register,OU=Urbana,DC=ad,DC=uillinois,DC=edu'
async function getCourseFromAD (config, course) {
  const client = new LDAP({ url: 'ldap://ad.uillinois.edu/' })
  return client.starttls({}, []).then(async () => {
    await client.bind(config.secrets.AD.username, config.secrets.AD.password)
    const results = await client.search(courseDN, {
      filter: `(CN=${course})`, scope: 'sub'
    })
    expect(results.entries.length).to.equal(1)

    return _(results.entries[0].object.member).map(member => {
      const [ , netID, group ] = /^CN=(.+?),OU=(.+?),/.exec(member)
      return group === 'People' ? netID : null
    }).filter(member => {
      return member !== null && config.ADIgnoreUsers.indexOf(member) === -1
    }).value()
  })
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

  let totalChanges = 0
  for (let email of changes.same) {
    let person = current[email]
    peopleCount++
    bulkPeople.find({
      _id: `${email}_${semester}`
    }).replaceOne(person)

    let existingPerson = _.omit(existing[email], ...config.recordIgnoreKeys)
    let currentPerson = _.omit(person, ...config.recordIgnoreKeys)

    let personDiff = deepDiff(existingPerson, currentPerson)
    if (personDiff !== undefined) {
      totalChanges++
      bulkChanges.insert({
        type: 'change',
        email: email,
        state: config.state,
        diff: personDiff,
        semester
      })
    }
  }
  config.log.debug(`${semester} ${type}: ${totalChanges} changes`)

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
    delete (person.labs)
  })

  for (let person of persons) {
    const email = person['Email Address']
    expect(email).to.be.ok()
    if (!(email in people)) {
      config.log.warn(`${email} signed up for sections in ${currentSemester} but missing from people`)
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
    return `${netID.trim()}@illinois.edu`
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
      expect.fail(`Day ${day} didn't match switch statement`)
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
    delete (person.officeHours)
  })

  const officeHours = await googleSpreadsheetToJSON({
    spreadsheetId: config.semesters[currentSemester].sheets.officeHours,
    credentials: config.secrets.google,
    propertyMode: 'none',
    worksheet: 'Weekly Schedule'
  })
  _.each(officeHours.slice(1), officeHour => {
    let TAs = []
    try {
      TAs = _.filter(netIDsToEmails(officeHour.TA.split(',')), email => {
        if (email !== '—@illinois.edu' && !(email in people)) {
          config.log.warn(`${email} signed up for office hours but not on staff`)
        }
        return email in people
      })
    } catch (err) { }
    let assistants = []
    try {
      assistants = _.filter(netIDsToEmails(officeHour.Assistants.split(',')), email => {
        if (email !== '—@illinois.edu' && !(email in people)) {
          config.log.warn(`${email} signed up for office hours but not on staff`)
        }
        return email in people
      })
    } catch (err) { }
    if (TAs.length + assistants.length === 0) {
      config.log.debug(`Ignoring ${officeHour.Day} ${officeHour.Start}: nobody there!`)
      return
    }
    const officeHourInfo = {
      location: officeHour.Location,
      day: officeHour.Day,
      start: `${Math.round(officeHour.Start * 24)}:00`,
      end: `${Math.round(officeHour.End * 24)}:00`,
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

async function addAllowedStaff (config, currentStaff, currentSemester) {
  let peopleCollection = config.database.collection('people')

  let staffByLab = {}
  _.each(currentStaff, staffMember => {
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
  _.each(currentStaff, staffMember => {
    if (!staffMember.labs || staffMember.labs.length === 0) {
      return
    }
    let labStaff = []
    for (let lab of staffMember.labs) {
      labStaff = labStaff.concat(_.keys(staffByLab[lab]))
    }
    staffMember.allowed = _([ ...allInstructors, ...labStaff ]).filter(email => {
      return email !== staffMember.email
    }).uniq().value().sort()
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

    let currentStaff = await getPeopleFromAD(config, staff.all)

    currentStaff = _.pickBy(currentStaff, person => {
      return (staff.all.indexOf(person.email) !== -1)
    })
    expect(_.keys(currentStaff).length).to.equal(staff.all.length)

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
      delete (staffMember.memberOf)
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

    currentStaff = _.pickBy(currentStaff, ({ active }) => { return active })

    if (!config.skipGravatars) {
      await addGravatar(config, _.values(currentStaff))
    }

    await addAllowedStaff(config, currentStaff, currentSemester)

    let existingStaff = _.keyBy(await peopleCollection.find({
      instructor: false, staff: true, semester: currentSemester, active: true
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
  _.each(currentStudents, student => {
    let labStaff = []
    if (student.lab) {
      labStaff = _.keys(staffByLab[student.lab])
    }
    student.allowed = _.uniq([ ...allInstructors, ...labStaff ]).sort()
  })
}

async function addSurvey (config, people) {
  let peopleCollection = config.database.collection('people')
  let changesCollection = config.database.collection('peopleChanges')

  config = _.extend(
    jsYAML.safeLoad(fs.readFileSync('survey.yaml', 'utf8')),
    config
  )
  const sheets = await googleSpreadsheetToJSON({
    spreadsheetId: config.sheet,
    credentials: config.secrets.google,
    propertyMode: 'none',
    worksheet: 'Form Responses 1'
  })

  const standalone = !people
  if (standalone) {
    people = _.keyBy(await peopleCollection.find({
      semester: config.semester, role: 'student'
    }).toArray(), 'email')
  }

  let surveys = {}
  let seen = {}
  for (let response of sheets) {
    let result = {}
    _.each(config.questions, (info, name) => {
      expect(info.question).to.be.a('array')
      let prompt = _.filter(_.keys(response), possiblePrompt => {
        return info.question.indexOf(possiblePrompt) !== -1
      })
      expect(prompt.length).to.be.at.most(1)
      if (prompt.length === 0) {
        return
      }
      if (!(name in seen)) {
        seen[name] = { chosen: {}, missed: {} }
      }
      prompt = prompt[0]
      result[name] = { prompt, type: info.type }

      let answer = response[prompt]
      switch (typeof (answer)) {
        case 'string':
          answer = answer.trim()
          break
      }

      if (info.type === 'free') {
        result[name].answer = answer
      } else if (info.type === 'truefalse') {
        switch (answer) {
          case 'Yes':
            result[name].answer = true
            break
          case 'No':
            result[name].answer = false
            break
        }
        expect(result[name]).to.not.be.undefined()
      } else if (info.type === 'range') {
        answer = parseInt(answer)
        result[name].answer = answer
      } else if (info.type === 'single' || info.type === 'multi') {
        expect(info.options).to.be.ok()
        let allOptions = _.map(answer.split(','), a => {
          return a.trim()
        })
        if (allOptions.length === 0) {
          return
        }
        let chosenOptions
        if (Array.isArray(info.options)) {
          chosenOptions = _(info.options).keyBy(value => {
            return value
          }).pickBy(value => {
            return allOptions.indexOf(value) !== -1
          }).value()
        } else if (typeof (info.options) === 'object') {
          chosenOptions = _(info.options).mapValues(value => {
            if (Array.isArray(value)) {
              let matches = _.intersection(allOptions, value)
              expect(matches.length).to.be.at.most(1)
              if (matches.length === 1) {
                return matches[0]
              } else {
                return ''
              }
            } else {
              return value
            }
          }).pickBy(value => {
            return allOptions.indexOf(value) !== -1
          }).value()
        }
        let missedOptions = _.difference(allOptions, _.values(chosenOptions))
        if (missedOptions.length > 1) {
          config.log.warn(`Problem answer: ${missedOptions.join(',')}`)
        } else if (missedOptions.length === 1) {
          expect(chosenOptions).to.not.have.property('other')
          chosenOptions['other'] = missedOptions[0]
        }
        result[name].answer = chosenOptions
        _.each(missedOptions, missed => {
          if (!(missed in seen[name].missed)) {
            seen[name].missed[missed] = 0
          }
          seen[name].missed[missed]++
        })
        _.each(chosenOptions, (unused, chosen) => {
          if (!(chosen in seen[name].chosen)) {
            seen[name].chosen[chosen] = 0
          }
          seen[name].chosen[chosen]++
        })
      }
    })
    const email = response[config.email].trim()
    expect(email).to.be.ok()
    const timestamp = moment(`1900-01-01 00:00:00`).add((response[config.timestamp] - 2) * 24, 'hours')
    const survey = {
      timestamp: timestamp.toDate(),
      questions: result
    }
    if (!(email in people)) {
      config.log.warn(`${email} took the survey but is not in the people collection`)
    } else {
      people[email].survey = survey
      surveys[email] = survey
    }
  }
  _.each(config.questions, (info, name) => {
    if (!(name in seen)) {
      config.log.warn(`Didn't see survey question ${name}`)
      return
    }
    if (info.options) {
      _.each(info.options, (value, key) => {
        const option = Array.isArray(info.options) ? value : key
        if (!(seen[name].chosen[option])) {
          config.log.warn(`Didn't see option ${option} for survey question ${name}`)
        }
      })
      _.each(seen[name].missed, (count, option) => {
        if (count > config.missedThreshold) {
          config.log.warn(`Missed popular option ${option} for survey question ${name}`)
        }
      })
    }
  })

  for (let email of _.keys(surveys)) {
    const survey = surveys[email]
    const existingSurvey = people[email].survey || {}
    if (_.isEqual(survey, existingSurvey)) {
      continue
    }
    if (!standalone) {
      await peopleCollection.updateOne({
        email, semester: config.semester
      }, {
        $set: {
          survey
        }
      })
    }
    await changesCollection.updateMany({
      email, semester: config.semester, type: 'joined'
    }, {
      $set: {
        'person.survey': survey
      }
    })
  }
}

async function students (config) {
  let stateCollection = config.database.collection('state')
  let peopleCollection = config.database.collection('people')

  const currentSemesters = await state.getActiveSemesters(config.database, config.people.startLoggingDaysBefore, config.people.endLoggingDaysAfter)

  for (let currentSemester of currentSemesters) {
    const semesterState = await stateCollection.findOne({ _id: currentSemester })
    const lectures = _.filter(semesterState.sections, sectionInfo => {
      return sectionInfo.lecture === true
    })
    const [ , semester, year ] = /^(.*?)(\d{4})$/.exec(currentSemester)

    let currentNetIDs = []
    for (const lecture of lectures) {
      currentNetIDs = currentNetIDs.concat(await getCourseFromAD(config, `CS 125 ${lecture.name} ${year} ${semester} CRN${lecture.CRN}`))
    }
    const currentStudents = await getPeopleFromAD(config, currentNetIDs)

    if (!config.skipGravatars) {
      await addGravatar(config, _.values(currentStudents))
    }

    _.each(currentStudents, student => {
      student.active = true
      student.semester = currentSemester
      student.staff = false
      student.student = true
      student.role = 'student'

      student.allCourses = _(student.memberOf).map(fullName => {
        const [ , groupName ] = /^CN=(.+?),/.exec(fullName)
        return groupName
      }).filter(groupName => {
        return groupName.match(/CRN\d+$/)
      }).value()

      const labs = _(student.allCourses).filter(name => {
        return name.match(`CS 125 ${config.labPrefix}\\w ${year} ${semester}`)
      }).map(name => {
        const [ , sectionName ] = name.match(`CS 125 (${config.labPrefix}\\w) ${year} ${semester}`)
        return sectionName
      }).value()

      if (labs.length === 0) {
        config.log.warn(`${student.email} is not assigned to a lab section`)
      } else if (labs.length > 1) {
        config.log.warn(`${student.email} is assigned to multiple lab sections`)
      } else {
        student.lab = labs[0]
      }

      const lectures = _(student.allCourses).filter(name => {
        return name.match(`CS 125 ${config.lecturePrefix}\\w ${year} ${semester}`)
      }).map(name => {
        const [ , sectionName ] = name.match(`CS 125 (${config.lecturePrefix}\\w) ${year} ${semester}`)
        return sectionName
      }).value()

      if (lectures.length === 0) {
        config.log.warn(`${student.email} is not assigned to a lecture`)
      } else if (lectures.length > 1) {
        config.log.warn(`${student.email} is assigned to multiple lectures`)
      } else {
        student.lecture = lectures[0]
      }

      const semesters = _(student.allCourses).filter(name => {
        return name.match(/\d{4} (Fall|Spring)/)
      }).map(name => {
        const [ semesterYear ] = name.match(/\d{4} (Fall|Spring)/)
        return semesterYear
      }).uniq().map(semesterYear => {
        const [ semester, year ] = semesterYear.split(' ')
        return { semester, year }
      }).sortBy([({ semester }) => {
        return semester === 'Fall' ? 0 : 1
      }, ({ year }) => {
        return parseInt(year)
      }]).map(({ semester, year }) => {
        return `${semester} ${year}`
      }).value()
      student.semesters = {
        count: semesters.length,
        started: semesters[0],
        all: semesters
      }

      delete(student.memberOf)
    })

    await addAllowed(config, currentStudents, currentSemester)
    await addSurvey(config, currentStudents)

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
  staff, students, getSemesterPeople, getAllSemesterPeople, getAllPeople, addOfficeHours, addAllowed, addSurvey
}

// vim: ts=2:sw=2:et:ft=javascript
