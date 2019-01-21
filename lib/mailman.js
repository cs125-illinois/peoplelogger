'use strict'

const _ = require('lodash')
const tmp = require('tmp')
const childProcess = require('child_process')
const chai = require('chai')
const expect = chai.expect
chai.use(require('dirty-chai'))
const fs = require('fs')
const ip = require('ip')
const state = require('./state')
const people = require('./people')
const moment = require('moment-timezone')

function syncList (config, name, people, memberFilter, moderatorFilter = null, dryRun = false) {
  const instructors = _(people).filter(person => {
    return person.instructor
  }).value()
  expect(instructors.length).to.be.at.least(1)
  const members = _(people).filter(memberFilter).concat(instructors).uniq().value()
  if (members.length === instructors.length) {
    config.log.warn(`${name} has no members`)
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

  config.log.debug(`${name} has ${_.keys(members).length} members`)
  let command
  command = `sudo remove_members -a -n -N ${name} 2>/dev/null`
  dryRun ? config.log.debug(command) : childProcess.execSync(command)
  command = `sudo add_members -w n -a n -r ${membersFile} ${name} 2>/dev/null`
  dryRun ? config.log.debug(command) : childProcess.execSync(command)
  command = `sudo withlist -r set_mod ${name} -s -a 2>/dev/null`
  dryRun ? config.log.debug(command) : childProcess.execSync(command)
  command = `sudo withlist -r set_mod ${name} -u ${moderators.join(' ')}  2>/dev/null`
  dryRun ? config.log.debug(command) : childProcess.execSync(command)

  try {
    fs.unlinkSync(membersFile)
  } catch (err) { }
}

async function mailman (config) {
  const dryRun = ip.address() !== config.mailServer
  if (dryRun) {
    config.log.warn(`Mailman dry run since we are not on the mail server`)
  }
  const currentSemesters = await state.getActiveSemesters(config.database, config.semesterStartsDaysBefore, config.semesterEndsDaysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  if (currentSemesters.length === 0) {
    return
  }
  const currentSemester = currentSemesters[0]
  const semesterConfig = config.semesters[currentSemester]
  const allPeople = await people.getSemesterPeople(config.database, currentSemester)

  syncList(
    config,
    `staff`,
    allPeople,
    ({ role }) => { return role === 'TA' },
    null,
    dryRun
  )
  syncList(
    config,
    `allstaff`,
    allPeople,
    ({ role }) => { return role === 'TA' || role === 'developer' || role === 'assistant' },
    null,
    dryRun
  )
  syncList(
    config,
    `developers`,
    allPeople,
    ({ role, active }) => { return role === 'developer' && active },
    null,
    dryRun
  )
  syncList(
    config,
    `prospective-developers`,
    allPeople,
    ({ role }) => { return role === 'developer' },
    true,
    dryRun
  )
  syncList(
    config,
    `assistants`,
    allPeople,
    ({ role, active }) => { return role === 'assistant' && active },
    true,
    dryRun
  )
  syncList(
    config,
    `labs`,
    allPeople,
    ({ staff, labs }) => { return staff && labs },
    ({ role, active }) => { return role === 'TA' && active },
    dryRun
  )
  syncList(
    config,
    `emp`,
    allPeople,
    (person) => { return person.staff && person.labs && person.labs.indexOf('EMP') !== -1 },
    (person) => { return person.role === 'TA' && person.labs && person.labs.indexOf('EMP') !== -1 && person.active },
    dryRun
  )
  syncList(
    config,
    `officehours`,
    allPeople,
    ({ staff, officeHours }) => { return staff && officeHours },
    ({ role, active }) => { return role === 'TA' && active },
    dryRun
  )
  syncList(
    config,
    `prospective-assistants`,
    allPeople,
    ({ role, active }) => { return role === 'assistant' && !active },
    true,
    dryRun
  )
  syncList(
    config,
    `students`,
    allPeople,
    ({ active }) => { return active },
    ({ role, active }) => { return role === 'TA' && active },
    dryRun
  )
  syncList(
    config,
    `temporary`,
    allPeople,
    ({ active, temporary }) => { return active && temporary },
    false,
    dryRun
  )
  if (semesterConfig.lateAdd) {
    syncList(
      config,
      `lateadd`,
      allPeople,
      ({ active, role, joined }) => { return active && role === 'student' && moment(joined).isAfter(moment.tz(new Date(semesterConfig.lateAdd), config.timezone)) },
      false,
      dryRun
    )
  }
}

module.exports = exports = {
  mailman
}

// vim: ts=2:sw=2:et:ft=javascript
