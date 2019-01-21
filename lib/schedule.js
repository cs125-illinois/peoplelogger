const _ = require('lodash')
const state = require('./state')
const chai = require('chai')
const expect = chai.expect
chai.use(require('dirty-chai'))

const moment = require('moment-timezone')

function dayNumberToLetter (number) {
  switch (number) {
    case 1:
      return 'M'
    case 2:
      return 'T'
    case 3:
      return 'W'
    case 4:
      return 'R'
    case 5:
      return 'F'
  }
}

async function schedule (config) {
  let stateCollection = config.database.collection('state')
  let scheduleCollection = config.database.collection('schedule')

  const currentSemesters = await state.getActiveSemesters(config.database, config.semesterStartsDaysBefore, config.semesterEndsDaysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  if (currentSemesters.length === 0) {
    return
  }
  const currentSemester = currentSemesters[0]
  const sections = (await stateCollection.find({
    _id: currentSemester
  }).toArray())[0].sections

  const sectionsByDay = {}
  _.each(sections, section => {
    section.days = section.days.split('')
    _.each(section.days, day => {
      if (!(day in sectionsByDay)) {
        sectionsByDay[day] = {}
      }
      sectionsByDay[day][section.name] = section
    })
  })

  await scheduleCollection.updateMany({
    semester: currentSemester
  }, {
    $set: {
      active: false
    }
  }, {
    multi: true
  })

  let currentDay =
    moment.tz(new Date(config.semesters[currentSemester].start), config.timezone)
  let lastDay =
    moment.tz(new Date(config.semesters[currentSemester].end), config.timezone)
  for (; currentDay.isSameOrBefore(lastDay); currentDay.add(1, 'days')) {
    const dayLetter = dayNumberToLetter(currentDay.day())
    if (!dayLetter) {
      continue
    }
    for (let currentSectionName of _.keys(sectionsByDay[dayLetter])) {
      let currentSection = sectionsByDay[dayLetter][currentSectionName]
      let startString = `${currentDay.format('YYYY-MM-DD')} ${currentSection.times.start}`
      let endString = `${currentDay.format('YYYY-MM-DD')} ${currentSection.times.end}`
      let startDate = moment.tz(moment(startString, 'YYYY-MM-DD hh:mmA'), config.timezone)
      let endDate = moment.tz(moment(endString, 'YYYY-MM-DD hh:mmA'), config.timezone)
      let weekStarting = moment.tz(startDate, config.timezone).startOf('isoWeek')
      let sectionInfo = {
        semester: currentSemester,
        start: startDate.toDate(),
        end: endDate.toDate(),
        startUnixtime: startDate.valueOf(),
        endUnixtime: endDate.valueOf(),
        weekStarting: weekStarting.toDate(),
        active: true,
        ...currentSection
      }
      await scheduleCollection.updateOne({
        semester: sectionInfo.semester,
        startUnixtime: sectionInfo.startUnixtime,
        endUnixtime: sectionInfo.endUnixtime,
        name: sectionInfo.name
      }, {
        $set: {
          ...sectionInfo
        }
      }, {
        upsert: true
      })
    }
  }
  await scheduleCollection.deleteMany({
    semester: currentSemester,
    active: false
  }, {
    multi: true
  })
}

module.exports = exports = {
  schedule
}
