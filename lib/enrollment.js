const _ = require('lodash')
const state = require('./state')
const people = require('./people')
const chai = require('chai')
const expect = chai.expect
chai.use(require('dirty-chai'))

function doBreakdowns (config, people, breakdowns, enrollments) {
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
        config.log.warn(`Enrollment key ${name} missing from ${person}`)
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

  const currentSemesters = await state.getActiveSemesters(config.database, config.semesterStartsDaysBefore, config.semesterEndsDaysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  if (currentSemesters.length === 0) {
    return
  }
  const currentSemester = currentSemesters[0]
  const allPeople = await people.getAllSemesterPeople(config.database, currentSemester)

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

  const activeStudents = _(allPeople).pickBy(({ active, role }) => { return active && role === 'student' }).values().value()
  enrollments.activeStudents.total = activeStudents.length
  doBreakdowns(config, activeStudents, studentBreakdowns, enrollments.activeStudents)
  const inActiveStudents = _(allPeople).pickBy(({ active, role }) => { return !active && role === 'student' }).values().value()
  enrollments.inactiveStudents.total = inActiveStudents.length
  doBreakdowns(config, inActiveStudents, studentBreakdowns, enrollments.inactiveStudents)

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

  const staff = _(allPeople).pickBy(({ active, staff, instructor }) => { return active && staff && !instructor }).values().value()
  enrollments.staff.total = staff.length
  doBreakdowns(config, staff, staffBreakdowns, enrollments.staff)

  config.log.trace(enrollments)

  await enrollmentCollection.insertOne(enrollments)
}

module.exports = exports = {
  enrollment
}
