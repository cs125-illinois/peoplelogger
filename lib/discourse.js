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
  config.log.debug(path)

  let result
  for (let retry = 0; retry < 15; retry++) {
    if (verb === 'get') {
      result = await discourseClient.get(path)
    } else if (verb === 'put' || verb === 'post') {
      result = await discourseClient[verb](path, body)
    } else if (verb === 'delete') {
      discourse.headers['X-Requested-With'] = 'XMLHTTPRequest'
      result = await discourseClient.delete(path)
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

async function update (config) {
  let peopleCollection = config.database.collection('people')
  let bulkPeople = peopleCollection.initializeUnorderedBulkOp()
  let discourseCollection = config.database.collection('discourse')
  let bulkDiscourse = discourseCollection.initializeUnorderedBulkOp()

  let allEmails = _(await config.database.collection('people').find({}).toArray()).map('email').uniq().value()

  const currentSemesters = await state.getActiveSemesters(config.database, config.semesterStartsDaysBefore, config.semesterEndsDaysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  let semesterEmails = []
  if (currentSemesters.length === 1) {
    semesterEmails = _(await config.database.collection('people').find({ semester: currentSemesters[0] }).toArray()).map('email').uniq().value()
  }

  let discourseUsers = {}
  let doPeople = false
  let doDiscourse = false
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
  config.log.debug(`Found ${_.keys(discourseUsers).length} Discourse users`)

  for (let user of _.values(discourseUsers)) {
    let detailedUserInfo = await callDiscourseAPI(config, {
      verb: 'get',
      path: `admin/users/${user.id}.json`
    })
    detailedUserInfo.groupIDs = _.map(detailedUserInfo.groups, 'id')
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
  config.log.debug(`Found ${_.keys(discourseGroups).length} Discourse groups`)

  return discourseGroups
}

async function updateDiscourseUser (config, userID, email) {
  let peopleCollection = config.database.collection('people')

  let detailedUserInfo = await callDiscourseAPI(config, {
    verb: 'get',
    path: `admin/users/${userID}.json`
  })
  detailedUserInfo.groupIDs = _.map(detailedUserInfo.groups, 'id')

  expect(email).to.be.ok()
  await peopleCollection.updateMany({ email }, {
    $set: {
      discourseUser: detailedUserInfo
    }
  })

  return detailedUserInfo
}

const PASSWORD_OPTIONS = { minimumLength: 10, maximumLength: 12 }
async function createDiscourseUser (config, person) {
  let peopleCollection = config.database.collection('people')

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

  await updateDiscourseUser(config, newUser.user_id, person.email)
}

async function syncUserGroups (config, person, discourseGroups, autoGroups, userGroups, userPrimaryGroup) {
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
  expect(person.discourseUser).to.be.ok()
  expect(discourseGroups).to.have.property(userPrimaryGroup)

  const toAdd = _.difference(shouldBeIn, person.discourseUser.groupIDs)
  const toRemove = _.intersection(shouldNotBeIn, person.discourseUser.groupIDs)
  if (toAdd.length > 0) {
    config.log.debug(`Adding ${ toAdd.length } groups`)
    for (let groupID of toAdd) {
      await callDiscourseAPI(config, {
        verb: 'post',
        path: `/admin/users/${ person.discourseUser.id }/groups`,
        body: {
          group_id: groupID
        }
      })
    }
  }
  if (toRemove.length > 0) {
    config.log.debug(`Removing ${ toAdd.length } groups`)
    for (let groupID of toRemove) {
      await callDiscourseAPI(config, {
        verb: 'delete',
        path: `/admin/users/${ person.discourseUser.id }/groups/${ groupID }`
      })
    }
  }

  expect(discourseGroups[userPrimaryGroup]).to.have.property('id')
  const userPrimaryGroupID = discourseGroups[userPrimaryGroup].id
  let updatedPrimaryGroup = false
  if (person.discourseUser.primary_group_id !== userPrimaryGroupID) {
    updatedPrimaryGroup = true
    await callDiscourseAPI(config, {
      verb: 'put',
      path: `/admin/users/${ person.discourseUser.id }/primary_group`,
      body: {
        primary_group_id: userPrimaryGroupID
      }
    })
  }

  if ((toRemove.length + toAdd.length > 0) || updatedPrimaryGroup) {
    const updatedUser = await updateDiscourseUser(config, person.discourseUser.id, person.email)
    expect(_.intersection(updatedUser.groupIDs, toAdd).length).to.equal(toAdd.length)
    expect(_.intersection(updatedUser.groupIDs, toRemove).length).to.equal(0)
    expect(updatedUser.primary_group_id).to.equal(userPrimaryGroupID)
  }

}

async function discourse (config) {
  await callDiscourseAPI(config, {
    verb: 'put',
    path: '/admin/site_settings/enable_local_logins',
    body: {
      enable_local_logins: true
    }
  })

  let people = _(await peopleLib.getAllPeople(config.database)).pickBy(person => {
    return !person.instructor
  }).values().keyBy('email').value()
  for (let person of _.values(people)) {
    if (!(person.discourseUser)) {
      await createDiscourseUser(config, person)
    }
  }
  people = _(await peopleLib.getAllPeople(config.database)).pickBy(person => {
    return !person.instructor
  }).values().keyBy('email').value()
  expect(_.filter(people, person => { return !person.discourseUser }).length).to.equal(0)

  const groups = await getAllDiscourseGroups(config)

  const currentSemesters = await state.getActiveSemesters(config.database, config.semesterStartsDaysBefore, config.semesterEndsDaysAfter)
  expect(currentSemesters.length).to.be.within(0, 1)
  const currentSemester = currentSemesters.length === 1 ? currentSemesters[0] : undefined

  let autoGroups = []
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
    config.log.debug(`${semester} has ${students.length} active students, ${TAs.length} TAs, ${CAs.length} active CAs, ${developers.length} developers, and ${inactive.length} inactive users`)
    expect(students.length + TAs.length + CAs.length + developers.length + inactive.length).to.equal(semesterPeople.length)

    autoGroups = autoGroups.concat([
      `${semester}`,
      `${semester}-TAs`,
      `${semester}-CAs`,
      `${semester}-CDs`,
      `${semester}-Staff`,
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
      if (semester === currentSemester) {
        moderators[email] = true
      }
    })
    _.each(CAs, email => {
      userGroups[email].push(`${semester}`)
      userGroups[email].push(`${semester}-CAs`)
      primaryGroup[email] = `${semester}-CAs`
      userGroups[email].push(`${semester}-Staff`)
      if (semester === currentSemester) {
        moderators[email] = true
      }
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

  for (let person of _.values(people)) {
    if (!(person.email in userGroups)) {
      userGroups[person.email] = [ 'Fall2017' ]
      primaryGroup[person.email] = 'Fall2017'
    }
    await syncUserGroups(config, person, groups, autoGroups, userGroups[person.email], primaryGroup[person.email])
  }

  await callDiscourseAPI(config, {
    verb: 'put',
    path: '/admin/site_settings/enable_local_logins',
    body: {
      enable_local_logins: false
    }
  })

  return

  /*
   * Set up moderators properly
   */
  let discourseModerators = _.pickBy(discoursePeople, user => {
    return user.moderator
  })
  config.log.debug(`Forum has ${_.keys(discourseModerators).length} moderators`)
  let missingModerators = _.difference(_.keys(moderators), _.keys(discourseModerators))
  if (missingModerators.length > 0) {
    config.log.debug(`Adding ${missingModerators.length} moderators`)
    let addModerators = async moderators => {
      for (let user of _.values(_.pick(discoursePeople, moderators))) {
        await callDiscourseAPI('put', `admin/users/${user.id}/grant_moderation`)
      }
    }
    await addModerators(missingModerators)
  }
  let extraModerators = _.difference(_.keys(discourseModerators), _.keys(moderators))
  if (extraModerators.length > 0) {
    config.log.debug(`Removing ${extraModerators.length} moderators`)
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

module.exports = exports = {
  update, discourse
}

/*
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

  for (let user of _.values(activeDiscoursePeople)) {
    await callDiscourseAPI('delete', `session/${ user.username }`, null, {})
  }
*/

// vim: ts=2:sw=2:et:ft=javascript
