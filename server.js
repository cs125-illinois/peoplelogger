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
const mongo = require('mongodb').MongoClient
const moment = require('moment-timezone')
const asyncLib = require('async')

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
const discourse = require('./lib/discourse')
const schedule = require('./lib/schedule')

let callTable = {
  reset: reset.reset,
  state: state.state,
  staff: people.staff,
  officeHours: people.addOfficeHours,
  students: people.students,
  survey: people.addSurvey,
  allowed: people.addAllowed,
  enrollment: enrollment.enrollment,
  activeSections: state.activeSections,
  mailman: mailman.mailman,
  updateDiscourseUsers: discourse.update,
  updateDiscourseGravatars: discourse.gravatars,
  discourse: discourse.discourse,
  schedule: schedule.schedule
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
    return enrollment.enrollment(config)
  }).then(() => {
    return schedule.schedule(config)
  }).then(() => {
    return state.activeSections(config)
  }).then(() => {
    return mailman.mailman(config)
  }).then(() => {
    return discourse.update(config)
  }).then(() => {
    return discourse.discourse(config)
  }).then(() => {
    return discourse.gravatars(config)
  }).then(() => {
    if (config.client) {
      config.client.close()
    }
    callback()
  }).catch(err => {
    log.fatal(`Run failed: ${ err }. Will retry later.`)
    callback()
  })
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
  let job = new CronJob('0 0 */2 * * *', async () => { // eslint-disable-line no-unused-vars
    queue.push({})
  }, null, true, 'America/Chicago')
  queue.push({})
}

process.on('unhandledRejection', (reason, promise) => {
  console.log(reason.stack || reason)
})

// vim: ts=2:sw=2:et:ft=javascript
