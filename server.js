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
const moment = require('moment')
const deepDiff = require('deep-diff').diff
const googleSpreadsheetToJSON = require('google-spreadsheet-to-json')
const emailAddresses = require('email-addresses')
const ip = require('ip')
const asyncLib = require('async')
const promptly = require('promptly')
const requestJSON = require('request-json')
const queryString = require('query-string')
const strictPasswordGenerator = require('strict-password-generator').default
const passwordGenerator = new strictPasswordGenerator()
const sleep = require('sleep')

const bunyan = require('bunyan')
const log = bunyan.createLogger({
  name: 'peoplelogger',
  streams: [
    {
      type: 'rotating-file',
      path: 'logs/peoplelogger.log',
      period: '1d',
      count: 365,
      level: 'info'
    }
  ]
})

/*
 * Example object from my.cs.illinois.edu:
 *
 * "Action": "",
 * "Admit Term": "Fall 2017",
 * "College": "Liberal Arts & Sciences",
 * "Degree": "BSLAS",
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

async function getExistingPeople (collection) {
  if (!collection) {
    var client = await mongo.connect(config.secrets.mongo)
    collection = client.db(config.database).collection('people')
  }
  let people = _.reduce(await collection.find({
      active: true
    }).toArray(), (people, person) => {
      people[person.email] = person
      return people
    }, {})
  if (client) {
    client.close()
  }
  return people
}

const blankPhoto = '1758209682'
async function people (config) {

  /*
   * Initialize mongo.
   */
  let client = await mongo.connect(config.secrets.mongo)
  let database = client.db(config.database)

  let stateCollection = database.collection('state')
  let peopleCollection = database.collection('people')
  let changesCollection = database.collection('peopleChanges')
  let enrollmentCollection = database.collection('enrollment')

  if (config.reset) {
    let reset = await promptly.choose('Are you sure you want to reset the database?', ['yes', 'no'])
    if (reset === 'yes') {
      stateCollection.deleteMany({})
      peopleCollection.deleteMany({})
      changesCollection.deleteMany({})
      enrollmentCollection.deleteMany({})
    } else {
      log.debug('Skipping reset')
    }
  }

  /*
   * Grab staff info.
   */
  let allStaff = {}
  let getStaff = async (name) => {
    let staff = []
    let sheet = await googleSpreadsheetToJSON({
      spreadsheetId: config.sheet,
      credentials: config.secrets.google,
      propertyMode: 'none',
      worksheet: [ name ]
    })
    _.each(sheet, inner => {
      _.each(inner, person  => {
        if ('Email' in person) {
          staff.push(person['Email'])
          allStaff[person['Email']] = person
        }
      })
    })
    return staff
  }
  try {
    var TAs = await getStaff('TAs')
    var volunteers = await getStaff('Volunteers')
    var developers = await getStaff('Developers')
    var staff = _.union(TAs, volunteers, developers)
  } catch (err) {
    throw(err)
    return
  }

  /*
   * Grab ffice hour info.
   */
  let officeHourStaff = []
  let sheet = await googleSpreadsheetToJSON({
    spreadsheetId: config.officehours,
    credentials: config.secrets.google,
    propertyMode: 'none',
    worksheet: [ 'Weekly Schedule' ]
  })
  _.each(sheet, inner => {
    _.each(inner, row  => {
      if (row['Assistants']) {
        _.each(row['Assistants'].toString().split(','), email => {
          email = `${ email.toLowerCase().trim() }@illinois.edu`
          if (staff.indexOf(email) !== -1) {
            officeHourStaff.push(email)
          }
        })
      }
    })
  })
  officeHourStaff = _.uniq(officeHourStaff)

  /*
   * Get section info.
   */
  let sectionCommand = `./lib/get-courses.illinois.edu ${ config.courses }`
  log.debug(`Running ${ sectionCommand }`)
  try {
    var sectionInfo = JSON.parse(childProcess.execSync(sectionCommand))
    if (config.sectionInfo) {
      sectionInfo = _.extend(sectionInfo, config.sectionInfo)
    }
  } catch (err) {
    throw err
    return
  }


  /*
   * Add staff to my.cs.illinois.edu
   */
  let staffNetIDs = _.map(staff, email => {
    return emailAddresses.parseOneAddress(email).local
  })

  npmPath.setSync()
  let configFile = tmp.fileSync()
  fs.writeFileSync(configFile.name, JSON.stringify(config))
  let addCommand = `casperjs lib/add-my.cs.illinois.edu ${ configFile.name } --netIDs=${ staffNetIDs.join(',') }`
  var options = {
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  }
  if (config.debugGet) {
    options.stdio = [0, 1, 2]
    addCommand += ' --verbose'
  }
  log.debug(`Running ${addCommand}`)
  try {
    childProcess.execSync(addCommand, options)
  } catch (err) {
    log.warn(err)
    // It's safe to continue here
  }

  /*
   * Scrape from my.cs.illinois.edu
   */
  let getCommand = `casperjs lib/get-my.cs.illinois.edu ${ configFile.name }`
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
    return
  }
  try {
    var currentPeople = JSON.parse(childProcess.execSync(getCommand, options).toString())
  } catch (err) {
    // Throw to make sure that we don't run other tasks
    throw err
    return
  }
  expect(_.keys(currentPeople)).to.have.lengthOf.above(1)
  log.debug(`Saw ${_.keys(currentPeople).length} people`)

  /*
   * Normalize retrieved data.
   */
  const matchClassID = new RegExp('\\s+(\\w+)$')
  let allSections = {}
  let normalizedPeople = _.mapValues(currentPeople, person => {
    let email = person['Net ID'] + `@illinois.edu`
    expect(emailValidator.validate(email)).to.be.true()

    let name = person['Name'].split(',')
    expect(name).to.have.lengthOf.above(1)
    let firstName = name[1].trim()
    let lastName = [name[0].trim(), name.slice(2).join('').trim()].join(' ')

    let normalizedPerson = {
      email: email,
      admitted: person['Admit Term'],
      college: person['College'],
      degree: person['Degree'],
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
      year: person['Year']
    }
    normalizedPerson.sections = _.reduce(person.classes, (all, c) => {
      c.ID = c['CRN']
      c.name = matchClassID.exec(c['class'].trim())[0].trim()
      delete (c['CRN'])
      delete (c['class'])
      c['credits'] = parseInt(c['credits'])
      all[c.name] = c
      allSections[c.name] = true
      normalizedPerson[c.name] = true
      return all
    }, {})
    if (stringHash(person.image) !== blankPhoto) {
      let photoData = base64JS.toByteArray(person.image)
      let photoType = imageType(photoData)
      expect(photoType).to.not.be.null()
      var photoSize = imageSize(Buffer.from(photoData))
      expect(photoSize).to.not.be.null()
      normalizedPerson.photo = {
        contents: person.image,
        type: photoType,
        size: photoSize
      }
    }

    if (TAs.indexOf(email) !== -1) {
      normalizedPerson.role = 'TA'
      normalizedPerson.staff = true
      normalizedPerson.section = true
      normalizedPerson.officehours = true
      normalizedPerson.scheduled = true
    } else if (developers.indexOf(email) !== -1) {
      normalizedPerson.role = 'developer'
      normalizedPerson.staff = true
      normalizedPerson.section = false
      normalizedPerson.officehours = false
      normalizedPerson.scheduled = true
    } else if (volunteers.indexOf(email) !== -1) {
      normalizedPerson.role = 'volunteer'
      normalizedPerson.staff = true
      normalizedPerson.officehours = (officeHourStaff.indexOf(email) !== -1)
      normalizedPerson.scheduled = (officeHourStaff.indexOf(email) !== -1)
    } else {
      normalizedPerson.role = 'student'
    }
    if (normalizedPerson.role === 'TA' || normalizedPerson.role === 'volunteer') {
      let mySections = allStaff[email]['Section']
      if (mySections && mySections.trim().length > 0) {
        let sections = mySections.trim().split(',')
        _.each(sections, section => {
          section = section.trim()
          expect(sectionInfo).to.have.property(section)
          normalizedPerson[section] = true
          normalizedPerson.scheduled = true
          normalizedPerson.seciton = true
        })
      }
    }
    return normalizedPerson
  })
  currentPeople = _.mapKeys(normalizedPeople, person => {
    return person.email
  })
  allSections = _.keys(allSections)
  _.each(sectionInfo, section => {
    section.active = (allSections.indexOf(section.name) !== -1)
  })

  /*
   * Save to Mongo.
   */
  let state = await stateCollection.findOne({ _id: 'peoplelogger' })
  if (state === null) {
    state = {
      _id: 'peoplelogger',
      counter: 1
    }
  } else {
    state.counter++
  }
  state.updated = moment().toDate()

  await stateCollection.save({
    _id: 'sectionInfo',
    updated: state.updated,
    sections: sectionInfo
  })

  let allPeople = _.reduce(await peopleCollection.find()
    .toArray(), (p, person) => {
      delete(person._id)
      delete(person.state)
      p[person.email] = person
      return p
    }, {})
  let existingPeople = _.pickBy(allPeople, person => {
    return person.active
  })
  _.each(allPeople, person => {
    delete(person.active)
  })
  _.each(existingPeople, person => {
    delete(person.active)
  })

  let joined = _.difference(_.keys(currentPeople), _.keys(existingPeople))
  let left = _.difference(_.keys(existingPeople), _.keys(currentPeople))
  let same = _.intersection(_.keys(currentPeople), _.keys(existingPeople))
  log.debug(`${ left.length } left, ${ joined.length } joined, ${ same.length } same`)

  let prepareForAddition = (person) => {
    person._id = person.email
    person.state = _.omit(state, '_id')
    return person
  }

  await Promise.all(_.map(joined, async newPerson => {
    await changesCollection.insert({
      type: 'joined',
      email: currentPeople[newPerson].email,
      state: _.omit(state, '_id')
    })
    if (!(newPerson in allPeople)) {
      return await peopleCollection.insert(prepareForAddition(currentPeople[newPerson]))
    } else {
      same.push(newPerson)
    }
  }))

  await Promise.all(_.map(same, async samePerson => {
    let existingPerson = allPeople[samePerson]
    let currentPerson = currentPeople[samePerson]

    let personDiff = deepDiff(existingPerson, currentPerson)
    await peopleCollection.save(prepareForAddition(currentPerson))

    if (personDiff !== undefined) {
      await changesCollection.insert({
        type: 'change',
        email: existingPerson.email,
        state: _.omit(state, '_id'),
        diff: personDiff
      })
    }
  }))

  await Promise.all(_.map(left, async leftPerson => {
    await changesCollection.insert({
      type: 'left',
      email: existingPeople[leftPerson].email,
      state: _.omit(state, '_id')
    })
  }))

  await changesCollection.insert({
    type: 'counter',
    state: _.omit(state, '_id')
  })

  await peopleCollection.updateMany({
    "state.counter": { $eq : state.counter },
  }, {
    $set: { active: true }
  })
  await peopleCollection.updateMany({
    "state.counter": { $ne : state.counter },
  }, {
    $set: { active: false }
  })
  let enrollments = {}
  _.each(allSections, section => {
    enrollments[section] = _(currentPeople)
    .filter(person => {
      return person.role === 'student' && (section in person.sections)
    })
    .value().length
  })
  enrollments['TAs'] = TAs.length
  enrollments['volunteers'] = volunteers.length
  enrollments['developers'] = developers.length
  enrollments.state = _.omit(state, '_id')

  await enrollmentCollection.insert(enrollments)
  await stateCollection.save(state)

  client.close()
}

async function mailman(config) {
  /*
   * Update mailman lists.
   */
  if (ip.address() !== config.server) {
    log.warn(`skipping mailman since we are not on the mail server`)
    return
  }
  let existingPeople = await getExistingPeople()

  let instructors = {
    'challen@illinois.edu': {
      name: {
        full: "Geoffrey Challen"
      },
      email: 'challen@illinois.edu'
    }
  }
  let syncList = (name, members, moderators) => {
    members = _.extend(_.clone(members), instructors)
    moderators = _.map(_.extend(_.clone(moderators), instructors), 'email')
    let membersFile = tmp.fileSync().name
    fs.writeFileSync(membersFile, _.map(members, p => {
      return `"${ p.name.full }" <${ p.email }>`
    }).join('\n'))
    log.debug(`${ name } has ${ _.keys(members).length } members`)
    childProcess.execSync(`sudo remove_members -a -n -N ${ name } 2>/dev/null`)
    childProcess.execSync(`sudo add_members -w n -a n -r ${ membersFile } ${ name } 2>/dev/null`)
    childProcess.execSync(`sudo withlist -r set_mod ${ name } -s -a 2>/dev/null`)
    childProcess.execSync(`sudo withlist -r set_mod ${ name } -u ${ moderators.join(' ')}  2>/dev/null`)
  }
  let TAs = _.pickBy(existingPeople, person => {
    return person.role === 'TA'
  })
  let volunteers = _.pickBy(existingPeople, person => {
    return person.role === 'volunteer'
  })
  let developers = _.pickBy(existingPeople, person => {
    return person.role === 'developer'
  })
  let students = _.pickBy(existingPeople, person => {
    return person.role === 'student'
  })
  syncList('staff', TAs, TAs)
  syncList('assistants', volunteers)
  syncList('developers', developers)
  syncList('students', _.extend(_.clone(students), TAs, volunteers, developers), TAs)
}

const passwordOptions = { minimumLength: 10, maximumLength: 12 }
async function discourse(config) {
  let existingPeople = await getExistingPeople()

  let moderators = _.pickBy(existingPeople, person => {
    return person.role === 'TA' || person.role === 'volunteer' || person.role === 'developer'
  })
  let users = _.pickBy(existingPeople, person => {
    return person.role === 'student'
  })
  existingPeople = _.extend(_.clone(moderators), users)

  let discourse = requestJSON.createClient(config.discourse)
  let callDiscourseAPI = async (verb, path, query, body) => {
    if (query === null) {
      query = {}
    }
    query = _.extend(_.clone(query), {
      api_username: config.secrets.discourse.username,
      api_key: config.secrets.discourse.key
    })
    path += '?' + queryString.stringify(query)
    log.debug(path)

    for (let retry = 0; retry < 15; retry++) {
      if (verb === 'get') {
        var result = await discourse.get(path)
      } else if (verb === 'put' || verb === 'post') {
        var result = await discourse[verb](path, body)
      }
      if (result.res.statusCode === 429 || result.res.statusCode === 500) {
        log.warn(`Sleeping for ${ result.res.statusCode }`)
        discourse = requestJSON.createClient(config.discourse)
        sleep.sleep(5)
      } else {
        break
      }
    }
    expect(result.res.statusCode).to.equal(200)
    return result.body
  }

  await callDiscourseAPI('put', 'admin/site_settings/enable_local_logins', null, {
    enable_local_logins: true
  })

  let getAllUsers = async () => {
    let discoursePeople = {}
    for (let page = 0; ; page++) {
      let newUsers = await callDiscourseAPI('get', 'admin/users/list/active.json', {
        show_emails: true, page: page + 1
      })
      if (newUsers.length === 0) {
        break
      }
      _.each(newUsers, user => {
        if (user.id <= 0 || user.admin) {
          return
        }
        expect(emailValidator.validate(user.email)).to.be.true()
        if (emailAddresses.parseOneAddress(user.email).domain !== 'illinois.edu') {
          return
        }
        discoursePeople[user.email] = user
      })
    }
    return discoursePeople
  }

  /*
   * Create new users.
   */
  let discoursePeople = await getAllUsers()
  log.debug(`Retrieved ${ _.keys(discoursePeople).length } users`)
  let create = _.difference(_.keys(existingPeople), _.keys(discoursePeople))
  if (create.length > 0) {
    log.debug(`Creating ${ create.length }`)
    let createUsers = async create => {
      for (let user of _.values(_.pick(existingPeople, create))) {
        await callDiscourseAPI('post', 'users', null, {
          name: user.name.full,
          email: user.email,
          username: emailAddresses.parseOneAddress(user.email).local,
          password: passwordGenerator.generatePassword(passwordOptions),
          active: 1,
          approved: 1
        })
      }
    }
    await createUsers(create)

    discoursePeople = await getAllUsers()
    create = _.difference(_.keys(existingPeople), _.keys(discoursePeople))
    expect(create).to.have.lengthOf(0)
  }

  /*
   * Suspend users that have left.
   */
  let activeDiscoursePeople = _.pickBy(discoursePeople, user => {
    return !user.suspended
  })
  log.debug(`${ _.keys(activeDiscoursePeople).length } are active`)
  let suspend = _.difference(_.keys(activeDiscoursePeople), _.keys(existingPeople))
  if (suspend.length > 0) {
    log.debug(`Suspending ${ suspend.length }`)
    let suspendUsers = async suspend => {
      for (let user of _.values(_.pick(discoursePeople, suspend))) {
        await callDiscourseAPI('post', `admin/users/${ user.id }/log_out`, null, {})
        if (user.moderator) {
          await callDiscourseAPI('put', `admin/users/${ user.id }/revoke_moderation`)
        }
        await callDiscourseAPI('put', `admin/users/${ user.id }/suspend`, null, {
          suspend_until: "3017-10-19 08:00",
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
    log.debug(`Reactivating ${ reactivate.length }`)
    let reactivateUsers = async reactivate => {
      for (let user of _.values(_.pick(discoursePeople, reactivate))) {
        await callDiscourseAPI('put', `admin/users/${ user.id }/unsuspend`, null, {})
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
   * Set up moderators properly
   */
  let discourseModerators = _.pickBy(discoursePeople, user => {
    return user.moderator
  })
  log.debug(`Forum has ${ _.keys(discourseModerators).length } moderators`)
  let missingModerators = _.difference(_.keys(moderators), _.keys(discourseModerators))
  if (missingModerators.length > 0) {
    log.debug(`Adding ${ missingModerators.length } moderators`)
    let addModerators = async moderators => {
      for (let user of _.values(_.pick(discoursePeople, moderators))) {
        await callDiscourseAPI('put', `admin/users/${ user.id }/grant_moderation`)
      }
    }
    await addModerators(missingModerators)
  }
  let extraModerators = _.difference(_.keys(discourseModerators), _.keys(moderators))
  if (extraModerators.length > 0) {
    log.debug(`Removing ${ extraModerators.length } moderators`)
    let removeModerators = async moderators => {
      for (let user of _.values(_.pick(discoursePeople, moderators))) {
        await callDiscourseAPI('put', `admin/users/${ user.id }/revoke_moderation`)
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
    level: "debug"
  })
} else {
  log.addStream({
    type: 'raw',
    stream: prettyStream,
    level: "warn"
  })
}
log.debug(_.omit(config, 'secrets'))

let queue = asyncLib.queue((unused, callback) => {
  people(config).then(() => {
    mailman(config)
  }).then(() => {
    discourse(config)
  }).catch(err => {
    log.fatal(err)
  })
  callback()
}, 1)

if (argv._.length === 0 && argv.oneshot) {
  queue.push({})
  queue.drain = () => {
    process.exit(0)
  }
} else if (argv.oneshot) {
  Promise.all([ eval(argv._[0])(config) ]).then(() => {
    process.exit(0)
  }).catch(err => {
    throw err
  })
} else {
  let CronJob = require('cron').CronJob
  let job = new CronJob('0 0 * * * *', async () => {
    queue.push({})
  }, null, true, 'America/Chicago')
  queue.push({})
}

// vim: ts=2:sw=2:et:ft=javascript
