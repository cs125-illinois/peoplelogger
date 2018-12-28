'use strict'

const _ = require('lodash')
const childProcess = require('child_process')
const moment = require('moment-timezone')
const chai = require('chai')
const expect = chai.expect
chai.use(require('dirty-chai'))

async function state (config) {
  let stateCollection = config.database.collection('state')
  let bulkState = stateCollection.initializeUnorderedBulkOp()

  const currentSemesters = await getActiveSemesters(config.database, config.people.startLoggingDaysBefore, config.people.endLoggingDaysAfter)

  for (let semester of currentSemesters) {
    const semesterConfig = config.semesters[semester]
    let sectionCommand = `./lib/get-courses.illinois.edu ${semesterConfig.courses}`
    config.log.debug(`Running ${sectionCommand}`)
    let sections = JSON.parse(childProcess.execSync(sectionCommand))
    expect(_.keys(sections).length).to.be.at.least(1)
    if (semesterConfig.extraSections) {
      sections = _.extend(sections, semesterConfig.extraSections)
    }
    _.each(sections, (sectionInfo, name) => {
      if (name.startsWith(config.lecturePrefix)) {
        sectionInfo.lecture = true
      }
    })
    bulkState.find({ _id: semester }).upsert().replaceOne({
      sections,
      start: moment.tz(new Date(semesterConfig.start), config.timezone).toDate(),
      end: moment.tz(new Date(semesterConfig.end), config.timezone).toDate(),
      state: config.state,
      isSemester: true
    })
  }

  const currentSemester = await getCurrentSemester(config.database)
  if (currentSemester) {
    bulkState.find({ _id: 'currentSemester' }).upsert().replaceOne({
      currentSemester: null
    })
  } else {
    bulkState.find({ _id: 'currentSemester' }).upsert().replaceOne({
      currentSemester
    })
  }

  await bulkState.execute()
}

function semesterIsActive (semester, daysBefore = 0, daysAfter = 0) {
  const semesterStart = moment(semester.start).subtract(daysBefore, 'days')
  const semesterEnd = moment(semester.end).add(daysAfter, 'days')
  return moment().isBetween(semesterStart, semesterEnd)
}

async function getActiveSemesters (database, daysBefore = 0, daysAfter = 0) {
  let stateCollection = database.collection('state')
  return _(await stateCollection.find({ isSemester: true }).toArray()).filter(semester => {
    return semesterIsActive(semester, daysBefore, daysAfter)
  }).map('_id').value()
}

async function getCurrentSemester (database, daysBefore = 0, daysAfter = 0) {
  const currentSemesters = await getActiveSemesters(database, daysBefore, daysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  return currentSemesters[0]
}

async function activeSections (config) {
  let stateCollection = config.database.collection('state')
  let peopleCollection = config.database.collection('people')

  for (let semester of _.keys(config.semesters)) {
    const sections = (await stateCollection.findOne({ _id: semester })).sections
    const activeLabs = _(await peopleCollection.find({
      semester, role: 'student', active: true, lab: { $exists: true }
    }).toArray()).map('lab').uniq().value()
    let updateQuery = {}
    for (let sectionName of _.keys(sections)) {
      const section = sections[sectionName]
      if (section.type === 'Lecture') {
        updateQuery[`sections.${sectionName}.active`] = true
      } else {
        updateQuery[`sections.${sectionName}.active`] = (activeLabs.indexOf(sectionName) !== -1)
      }
    }
    await stateCollection.updateOne({ _id: semester }, { $set: updateQuery })
  }
}

module.exports = exports = {
  state,
  semesterIsActive,
  getActiveSemesters,
  getCurrentSemester,
  activeSections
}

// vim: ts=2:sw=2:et:ft=javascript
