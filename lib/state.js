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

  _.each(config.semesters, (semesterConfig, semester) => {
    let sectionCommand = `./lib/get-courses.illinois.edu ${semesterConfig.courses}`
    config.log.debug(`Running ${sectionCommand}`)
    let sections = JSON.parse(childProcess.execSync(sectionCommand))
    expect(_.keys(sections).length).to.be.at.least(1)
    if (semesterConfig.extraSections) {
      sections = _.extend(sections, semesterConfig.extraSections)
    }
    bulkState.find({ _id: semester }).upsert().replaceOne({
      sections,
      start: moment.tz(new Date(semesterConfig.start), config.timezone).toDate(),
      end: moment.tz(new Date(semesterConfig.end), config.timezone).toDate(),
      state: config.state,
      isSemester: true
    })
  })

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

module.exports = exports = {
  state,
  semesterIsActive,
  getActiveSemesters,
  getCurrentSemester
}

// vim: ts=2:sw=2:et:ft=javascript
