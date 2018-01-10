#!/usr/bin/env node

require('dotenv').config()
const _ = require('lodash')
const debug = require('debug')('peoplelogger')

const express = require('express')
const bodyParser = require('body-parser')
const mongo = require('mongodb').MongoClient
const bunyan = require('bunyan')
const moment = require('moment')
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

mongo.connect(process.env.MONGO)
  .then(client => {
    progress = client.db('MPs').collection('progress')
    app.listen(config.port)
  })

// vim: ts=2:sw=2:et:ft=javascript
