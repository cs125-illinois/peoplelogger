const MATCH_CLASS_ID = new RegExp('\\s+(\\w+)$')
async function getFromMyCS (config, semester, getConfig) {
  let configFile = tmp.fileSync()
  fs.writeFileSync(configFile.name, JSON.stringify(getConfig))

  let getCommand = `casperjs lib/get-my.cs.illinois.edu ${configFile.name}`
  var options = {
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  }
  if (config.debugGet) {
    options.stdio = [0, 1, 2]
    getCommand += ' --verbose'
  }

  config.log.debug(`Running ${getCommand}`)
  if (config.debugGet) {
    // Can't recover the JSON in this case, so just return
    childProcess.execSync(getCommand, options)
    try {
      fs.unlinkSync(configFile.name)
    } catch (err) {
      config.log.warn(err)
    }
    return
  }
  try {
    var currentPeople = JSON.parse(childProcess.execSync(getCommand, options).toString())
    try {
      fs.unlinkSync(configFile.name)
    } catch (err) { }
  } catch (err) {
    // Throw to make sure that we don't run other tasks
    throw err
  }

  expect(_.keys(currentPeople)).to.have.lengthOf.above(1)
  config.log.debug(`Saw ${_.keys(currentPeople).length} people`)

  return _(currentPeople).mapValues(person => {
    let email = person['Net ID'] + `@illinois.edu`
    expect(emailValidator.validate(email)).to.be.true()

    let name = person['Name'].split(',')
    expect(name).to.have.lengthOf.above(1)
    let firstName = name[1].trim()
    let lastName = [name[0].trim(), name.slice(2).join('').trim()].join(' ')
    if (firstName === '-') {
      firstName = ''
    }

    let normalizedPerson = {
      email,
      semester,
      admitted: person['Admit Term'], // Need
      college: person['College'],
      gender: person['Gender'], // Form
      level: person['Level'],
      major: person['Major 1 Name'],
      hidden: (person['FERPA'] === 'Y'), // Need
      name: {
        full: firstName + ' ' + lastName.trim(),
        first: firstName.trim(),
        last: lastName.trim()
      },
      username: person['Net ID'],
      ID: person['UIN'],
      year: person['Year'], // Need
      instructor: false,
      state: config.state,
      image: person.image,
      left: false
    }

    if (firstName === '') {
      normalizedPerson.name.full = lastName
    }

    normalizedPerson.sections = _(person.classes).map(info => {
      let section = {
        ID: info['CRN'],
        name: MATCH_CLASS_ID.exec(info['class'].trim())[0].trim()
      }
      section.credits = parseInt(info.credits)
      if (isNaN(section.credits)) {
        delete (info.credits)
      }
      return section
    }).keyBy(section => {
      return section.name
    }).value()
    normalizedPerson.totalCredits = _.reduce(normalizedPerson.sections, (total, section) => {
      return section.credits ? total + section.credits : total
    }, 0)

    _.each(normalizedPerson, (value, key) => {
      if (value === undefined || value === null) {
        delete (normalizedPerson[key])
      }
    })

    return normalizedPerson
  }).keyBy('email').value()
}

/*
 * Example object from my.cs.illinois.edu:
 *
 * "Action": "",
 * "Admit Term": "Fall 2017",
 * "College": "Liberal Arts & Sciences",
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
