'use strict'

const _ = require('lodash')
const chai = require('chai')
const expect = chai.expect
chai.use(require('dirty-chai'))
const requestJSON = require('request-json')
const queryString = require('query-string')
const StrictPasswordGenerator = require('strict-password-generator').default
const passwordGenerator = new StrictPasswordGenerator()
const sleep = require('sleep')
const emailValidator = require('email-validator')
const emailAddresses = require('email-addresses')
const state = require('./state')
const peopleLib = require('./people')
const moment = require('moment-timezone')
const deepDiff = require('deep-diff').diff

let discourseClient
let successCount = 0
async function callDiscourseAPI (config, request) {
  let discourseClient = requestJSON.createClient(config.discourseURL)

  let { verb, path, query, body } = request
  query = query !== undefined ? query : {}
  path += '?' + queryString.stringify(query)
  config.log.trace(path)

  discourseClient.headers['Api-Key'] = config.secrets.discourse.key
  discourseClient.headers['Api-Username'] = config.secrets.discourse.username

  let result
  for (let retry = 0; retry < 15; retry++) {
    try {
      if (verb === 'get') {
        result = await discourseClient.get(path)
      } else if (verb === 'put' || verb === 'post') {
        result = await discourseClient[verb](path, body)
      } else if (verb === 'delete') {
        discourseClient.headers['X-Requested-With'] = 'XMLHTTPRequest'
        result = await discourseClient.delete(path)
      }
      successCount++
    } catch (err) {
      config.log.warn(`Sleeping for ${err} (${ successCount })`)
      successCount = 0
      sleep.sleep(5)
      continue
    }
    expect(result).to.be.ok()
    if (result.res.statusCode === 429 || result.res.statusCode === 500) {
      config.log.warn(`Sleeping for ${result.res.statusCode}`)
      sleep.sleep(5)
    } else {
      break
    }
  }
  expect(result.res.statusCode).to.equal(200)
  return result.body
}

function cleanDetailedInfo (detailedInfo) {
  detailedInfo = _.pickBy(detailedInfo, (value, name) => {
    return !(name.endsWith('_age'))
  })

  detailedInfo.groupIDs = _(detailedInfo.groups).sortBy('id').map('id').value()
  detailedInfo.groupNames = _(detailedInfo.groups).sortBy('id').map('name').value()
  delete (detailedInfo.groups)

  return detailedInfo
}

async function update (config) {
  let discourseUsersCollection = config.database.collection('discourseUsers')
  let bulkDiscourseUsers = discourseUsersCollection.initializeUnorderedBulkOp()
  let discourseUserChangesCollection = config.database.collection('discourseUserChanges')
  let bulkDiscourseUserChanges = discourseUserChangesCollection.initializeUnorderedBulkOp()

  let existingDiscourseUsers = _.keyBy(await discourseUsersCollection.find({
    active: true
  }).toArray(), 'email')
  config.log.debug(`Found ${_.keys(existingDiscourseUsers).length} existing Discourse users`)

  let currentDiscourseUsers = {}
  config.log.debug(`Updating Discourse users (takes a while)`)
  for (let page = 0; ; page++) {
    let newUsers = await callDiscourseAPI(config, {
      verb: 'get',
      path: 'admin/users/list/new.json',
      query: { show_emails: true, page }
    })
    if (newUsers.length === 0) {
      break
    }
    for (let user of newUsers) {
      if (user.id <= 0 || user.admin) {
        // config.log.debug(`Skipping ${ user.email }: admin`)
        continue
      }
      expect(emailValidator.validate(user.email)).to.be.true()
      const emailDomain = emailAddresses.parseOneAddress(user.email).domain
      if (emailDomain !== 'illinois.edu') {
        // config.log.debug(`Skipping ${ user.email }: bad email`)
        continue
      }

      let detailedInfo
      for (let retry = 0; retry < 5; retry++) {
        detailedInfo = cleanDetailedInfo(await callDiscourseAPI(config, {
          verb: 'get',
          path: `admin/users/${user.id}.json`
        }))
        if (detailedInfo.id === user.id) {
          break
        }
        config.log.debug(`Failed to retrieve information for ${user.email}. Retrying`)
      }
      expect(detailedInfo.id).to.equal(user.id)

      currentDiscourseUsers[user.email] = {
        email: user.email,
        ...detailedInfo
      }
    }
  }
  config.log.debug(`Found ${_.keys(currentDiscourseUsers).length} current Discourse users`)

  for (let user of _.values(currentDiscourseUsers)) {
    user.active = true
    bulkDiscourseUsers.find({
      _id: user.email
    }).upsert().replaceOne(user)
    if (!(existingDiscourseUsers[user.email])) {
      bulkDiscourseUserChanges.insert({
        type: 'joined',
        email: user.email,
        state: config.state,
        user
      })
    } else {
      let existingUser = _.omit(existingDiscourseUsers[user.email], '_id')
      let currentUser = _.omit(user, '_id')
      let discoursePersonDiff = deepDiff(existingUser, currentUser)
      if (discoursePersonDiff !== undefined) {
        bulkDiscourseUserChanges.insert({
          type: 'change',
          email: user.email,
          state: config.state,
          diff: discoursePersonDiff
        })
      }
    }
  }
  for (let user of _.values(existingDiscourseUsers)) {
    if (currentDiscourseUsers[user.email]) {
      continue
    }
    bulkDiscourseUsers.find({
      _id: user.email
    }).updateOne({
      $set: {
        active: false
      }
    })
    bulkDiscourseUserChanges.insert({
      type: 'left',
      email: user.email,
      state: config.state
    })
  }

  bulkDiscourseUserChanges.find({
    type: 'counter',
    'state.counter': config.state.counter
  }).upsert().replaceOne({ type: 'counter', state: config.state })

  await bulkDiscourseUsers.execute()
  await bulkDiscourseUserChanges.execute()
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
  config.log.debug(`Found ${_.keys(discourseGroups).length} Discourse groups`)

  return discourseGroups
}

async function updateDiscourseUser (config, userID, email) {
  let discourseUsersCollection = config.database.collection('discourseUsers')

  let detailedUserInfo = cleanDetailedInfo(await callDiscourseAPI(config, {
    verb: 'get',
    path: `admin/users/${userID}.json`
  }))
  expect(email).to.be.ok()
  await discourseUsersCollection.replaceOne({
    _id: email
  }, {
    active: true, email, ...detailedUserInfo
  }, {
    upsert: true
  })

  return detailedUserInfo
}

const PASSWORD_OPTIONS = { minimumLength: 10, maximumLength: 12 }
async function createDiscourseUser (config, person) {
  config.log.debug(`Creating ${person.email}`)

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
  expect(newUser.user_id).to.be.ok()
  const newDiscourseUser = await updateDiscourseUser(config, newUser.user_id, person.email)
  return newDiscourseUser
}

async function syncUserGroups (config, person, discourseGroups, autoGroups, userGroups, userPrimaryGroup) {
  let userPrimaryGroupID
  if (userPrimaryGroup) {
    expect(userGroups.indexOf(userPrimaryGroup)).to.not.equal(-1)
    expect(discourseGroups[userPrimaryGroup]).to.have.property('id')
    userPrimaryGroupID = discourseGroups[userPrimaryGroup].id
  }

  let shouldBeIn = _(autoGroups).filter(name => {
    return userGroups.indexOf(name) !== -1
  }).map(name => {
    return discourseGroups[name].id
  }).value()
  if (userPrimaryGroup) {
    _.remove(shouldBeIn, id => {
      return id === userPrimaryGroupID
    })
    shouldBeIn.unshift(userPrimaryGroupID)
    expect(shouldBeIn[0]).to.equal(userPrimaryGroupID)
    expect(_.uniq(shouldBeIn).length).to.equal(shouldBeIn.length)
  }

  const shouldNotBeIn = _(autoGroups).filter(name => {
    return userGroups.indexOf(name) === -1
  }).map(name => {
    return discourseGroups[name].id
  }).value()

  expect(shouldBeIn.length + shouldNotBeIn.length).to.equal(autoGroups.length)
  expect(person.discourseUser).to.be.ok()
  if (userPrimaryGroup) {
    expect(discourseGroups).to.have.property(userPrimaryGroup)
  }

  const toAdd = _.difference(shouldBeIn, person.discourseUser.groupIDs)
  const toRemove = _.intersection(shouldNotBeIn, person.discourseUser.groupIDs)
  if (toRemove.length > 0) {
    config.log.trace(`Removing ${toRemove.length} groups`)
    for (let groupID of toRemove) {
      await callDiscourseAPI(config, {
        verb: 'delete',
        path: `/admin/users/${person.discourseUser.id}/groups/${groupID}`
      })
    }
  }
  if (toAdd.length > 0) {
    config.log.trace(`Adding ${toAdd.length} groups`)
    for (let groupID of toAdd) {
      await callDiscourseAPI(config, {
        verb: 'post',
        path: `/admin/users/${person.discourseUser.id}/groups`,
        body: {
          group_id: groupID
        }
      })
    }
  }

  let updatedPrimaryGroup = false
  if (userPrimaryGroup && person.discourseUser.primary_group_id !== userPrimaryGroupID) {
    updatedPrimaryGroup = true
    await callDiscourseAPI(config, {
      verb: 'put',
      path: `/admin/users/${person.discourseUser.id}/primary_group`,
      body: {
        primary_group_id: userPrimaryGroupID
      }
    })
  } else if (!userPrimaryGroup && person.discourseUser.primary_group_id !== null) {
    await callDiscourseAPI(config, {
      verb: 'put',
      path: `/admin/users/${person.discourseUser.id}/primary_group`,
      body: {
        primary_group_id: ''
      }
    })
  }

  if ((toRemove.length + toAdd.length > 0) || updatedPrimaryGroup) {
    const updatedUser = await updateDiscourseUser(config, person.discourseUser.id, person.email)
    expect(_.intersection(updatedUser.groupIDs, toAdd).length).to.equal(toAdd.length)
    expect(_.intersection(updatedUser.groupIDs, toRemove).length).to.equal(0)
    if (userPrimaryGroup) {
      expect(updatedUser.primary_group_id).to.equal(userPrimaryGroupID)
    } else {
      expect(updatedUser.primary_group_id).to.be.null()
    }
  }
}

async function discourse (config) {
  let discourseUsersCollection = config.database.collection('discourseUsers')

  await callDiscourseAPI(config, {
    verb: 'put',
    path: '/admin/site_settings/enable_local_logins',
    body: {
      enable_local_logins: true
    }
  })

  let people = _.pickBy(await peopleLib.getAllPeople(config.database), person => {
    if (person.instructor) {
      return false
    } else if (config.discourseIgnore && config.discourseIgnore.includes(person.email)) {
      return false
    }
    return true
  })

  let discourseUsers = _(await discourseUsersCollection.find({}).toArray()).filter(user => {
    return user.active
  }).keyBy('email').value()
  for (let person of _.values(people)) {
    if (!(person.email in discourseUsers)) {
      discourseUsers[person.email] = await createDiscourseUser(config, person)
    }
    person.discourseUser = discourseUsers[person.email]
  }
  expect(_.filter(people, person => { return !person.discourseUser }).length).to.equal(0)

  const groups = await getAllDiscourseGroups(config)

  const currentSemesters = await state.getActiveSemesters(config.database, config.semesterStartsDaysBefore, config.semesterEndsDaysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  const currentSemester = currentSemesters.length === 1 ? currentSemesters[0] : undefined

  let autoGroups = [ 'CurrentStaff' ]
  let userGroups = {}
  let primaryGroup = {}
  let moderators = {}
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
    const heads = _(semesterPeople).values().filter(person => {
      return person.role === 'head'
    }).map('email').value()
    const captains = _(semesterPeople).values().filter(person => {
      return person.role === 'captain'
    }).map('email').value()
    const TAs = _(semesterPeople).values().filter(person => {
      return person.role === 'TA'
    }).map('email').value()
    const associates = _(semesterPeople).values().filter(person => {
      return person.role === 'associate' && person.active
    }).map('email').value()
    const CAs = _(semesterPeople).values().filter(person => {
      return person.role === 'assistant' && person.active
    }).map('email').value()
    const developers = _(semesterPeople).values().filter(person => {
      return person.role === 'developer'
    }).map('email').value()
    const dataanalysts = _(semesterPeople).values().filter(person => {
      return person.role === 'data analyst'
    }).map('email').value()
    const labs = _(semesterPeople).values().filter(person => {
      return person.staff && person.labs && person.active
    }).map('email').value()
    const PL = _(semesterPeople).values().filter(person => {
      return (person.role === 'TA' || person.role === 'captain' || person.role === 'associate') && person.active
    }).map('email').value()

    const inactive = _(semesterPeople).values().filter(person => {
      return students.indexOf(person.email) === -1 &&
        captains.indexOf(person.email) === -1 &&
        TAs.indexOf(person.email) === -1 &&
        CAs.indexOf(person.email) === -1 &&
        developers.indexOf(person.email) === -1 &&
        heads.indexOf(person.email) === -1 &&
        dataanalysts.indexOf(person.email) === -1
    }).map('email').value()
    config.log.debug(`${semester} has ${students.length} active students, ${TAs.length} TAs, ${CAs.length} active CAs, ${developers.length} developers, and ${inactive.length} inactive users`)
    expect(students.length + captains.length + TAs.length + CAs.length + developers.length + dataanalysts.length + heads.length + inactive.length).to.equal(semesterPeople.length)

    autoGroups = autoGroups.concat([
      `${semester}`,
      `${semester}-Captains`,
      `${semester}-TAs`,
      `${semester}-CAs`,
      `${semester}-CDs`,
      `${semester}-Data`,
      `${semester}-Staff`,
      `${semester}-Inactive`,
      `${semester}-Labs`,
      `${semester}-PL`,
      `${semester}-Associate`
    ])
    if (semester === currentSemester) {
      autoGroups.push(`${ semester }-Help`)
    }

    _.each(students, email => {
      userGroups[email].push(`${semester}`)
      if (!primaryGroup[email]) {
        primaryGroup[email] = `${semester}`
      }
    })
    _.each(TAs, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-TAs`)
      userGroups[email].push(`${semester}-Staff`)
      if (!primaryGroup[email]) {
        primaryGroup[email] = `${semester}-TAs`
      }
      if (semester === currentSemester) {
        userGroups[email].push(`CurrentStaff`)
        userGroups[email].push(`staff`)
        userGroups[email].push(`${semester}-Help`)
      }
    })
    _.each(captains, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-Captains`)
      userGroups[email].push(`${semester}-CAs`)
      userGroups[email].push(`${semester}-Staff`)
      if (!primaryGroup[email]) {
        primaryGroup[email] = `${semester}-Captains`
      }
      if (semester === currentSemester) {
        userGroups[email].push(`CurrentStaff`)
        userGroups[email].push(`staff`)
        userGroups[email].push(`${semester}-Help`)
      }
    })
    _.each(heads, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-CAs`)
      userGroups[email].push(`${semester}-Staff`)
      if (!primaryGroup[email]) {
        primaryGroup[email] = `${semester}-Staff`
      }
      if (semester === currentSemester) {
        userGroups[email].push(`CurrentStaff`)
        userGroups[email].push(`staff`)
        userGroups[email].push(`${semester}-Help`)
      }
    })
    _.each(CAs, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-CAs`)
      userGroups[email].push(`${semester}-Staff`)
      if (!primaryGroup[email]) {
        primaryGroup[email] = `${semester}-CAs`
      }
      if (semester === currentSemester) {
        userGroups[email].push(`CurrentStaff`)
        userGroups[email].push(`staff`)
        userGroups[email].push(`${semester}-Help`)
      }
    })
    _.each(associates, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-CAs`)
      userGroups[email].push(`${semester}-Associate`)
      userGroups[email].push(`${semester}-Staff`)
      if (!primaryGroup[email]) {
        primaryGroup[email] = `${semester}-Associate`
      }
      if (semester === currentSemester) {
        userGroups[email].push(`CurrentStaff`)
        userGroups[email].push(`staff`)
        userGroups[email].push(`${semester}-Help`)
      }
    })
    _.each(developers, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-CDs`)
      userGroups[email].push(`${semester}-Staff`)
      if (!primaryGroup[email]) {
        primaryGroup[email] = `${semester}-CDs`
      }
      if (semester === currentSemester) {
        userGroups[email].push(`CurrentStaff`)
        userGroups[email].push(`staff`)
      }
    })
    _.each(dataanalysts, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-Data`)
      userGroups[email].push(`${semester}-CDs`)
      userGroups[email].push(`${semester}-Staff`)
      if (!primaryGroup[email]) {
        primaryGroup[email] = `${semester}-Data`
      }
      if (semester === currentSemester) {
        userGroups[email].push(`CurrentStaff`)
        userGroups[email].push(`staff`)
      }
    })
    _.each(inactive, email => {
      userGroups[email].push(`${semester}-Inactive`)
      if (!primaryGroup[email]) {
        primaryGroup[email] = `${semester}-Inactive`
      }
    })
    _.each(labs, email => {
      if (semester === currentSemester) {
        userGroups[email].push(`${semester}-Labs`)
      }
    })
    _.each(PL, email => {
      if (semester === currentSemester) {
        userGroups[email].push(`${semester}-PL`)
      }
    })
  })

  autoGroups = _.filter(autoGroups, group => {
    return group in groups
  })

  for (let group of autoGroups) {
    expect(groups).to.have.property(group)
    const groupInfo = groups[group]
    expect(groupInfo.automatic).to.equal(false)
  }

  let distinctPeople = _.keyBy(people, 'email')
  for (let person of _.values(distinctPeople)) {
    expect(userGroups).to.have.property(person.email)
    // await syncUserGroups(config, person, groups, autoGroups, [], null)
    await syncUserGroups(config, person, groups, autoGroups, userGroups[person.email], primaryGroup[person.email])
  }

  await callDiscourseAPI(config, {
    verb: 'put',
    path: '/admin/site_settings/enable_local_logins',
    body: {
      enable_local_logins: false
    }
  })
}

async function gravatars (config) {
  let discourseUsersCollection = config.database.collection('discourseUsers')

  let discourseUsers = _(await discourseUsersCollection.find({}).toArray()).filter(user => {
    return user.active
  }).keyBy('email').value()
  let people = _.pickBy(await peopleLib.getAllPeople(config.database), person => {
    person.discourseUser = discourseUsers[person.email]
    return person.discourseUser
  })
  let distinctPeople = _.keyBy(people, 'email')
  config.log.debug(`Updating Discourse gravatars...`)

  for (let person of _.values(distinctPeople)) {
    if (!person.hasGravatar) {
      continue
    }
    let user = await callDiscourseAPI(config, {
      verb: 'get',
      path: `/users/${ person.discourseUser.username }.json`
    })
    if (user.user.gravatar_avatar_upload_id) {
      continue
    }
    try {
      const response = await callDiscourseAPI(config, {
        verb: 'post',
        path: `/user_avatar/${person.discourseUser.username}/refresh_gravatar.json`
      })
      expect(response.gravatar_upload_id).to.be.ok()
      await callDiscourseAPI(config, {
        verb: 'put',
        path: `/u/${person.discourseUser.username}/preferences/avatar/pick`,
        body: {
          upload_id: response.gravatar_upload_id,
          type: 'gravatar'
        }
      })
      config.log.trace(`Set Gravatar for ${person.email}`)
      await updateDiscourseUser(config, person.discourseUser.id, person.email)
    } catch (err) {
      config.log.warn(`Error setting Gravatar for ${person.email}: ${err}`)
    }
  }
}

module.exports = exports = {
  update, discourse, gravatars
}

// vim: ts=2:sw=2:et:ft=javascript
