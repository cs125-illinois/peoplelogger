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
const emailValidator = require('email-validator')
const mongo = require('mongodb').MongoClient
const moment = require('moment-timezone')
const emailAddresses = require('email-addresses')
const asyncLib = require('async')
const requestJSON = require('request-json')
const queryString = require('query-string')
const StrictPasswordGenerator = require('strict-password-generator').default
const passwordGenerator = new StrictPasswordGenerator()
const sleep = require('sleep')

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
const people = require('./lib/people')
const enrollment = require('./lib/enrollment')
const mailman = require('./lib/mailman')

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
  reset: reset.reset,
  state: state.state,
  staff: people.staff,
  students: people.students,
  enrollment: enrollment.enrollment,
  mailman: mailman.mailman,
  updateDiscourseUsers,
  discourse
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
    return people.staff(config)
  }).then(() => {
    return people.students(config)
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
        return callTable[command](config)
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
