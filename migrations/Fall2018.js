#!/usr/bin/env node

'use strict'

const _ = require('lodash')
const jsYAML = require('js-yaml')
const fs = require('fs')
const mongo = require('mongodb').MongoClient
const moment = require('moment-timezone')

let config = _.extend(
  jsYAML.safeLoad(fs.readFileSync('./config.yaml', 'utf8')),
  jsYAML.safeLoad(fs.readFileSync('./secrets.yaml', 'utf8')),
)

mongo.connect(config.secrets.mongo).then(client => {
  const database = client.db(config.database)

  // State table
  let stateCollection = database.collection('state')
  stateCollection.removeOne({ _id: 'sectionInfo' })

  client.close()
})

// vim: ts=2:sw=2:et:ft=javascript
