#!/usr/bin/env bash

echo "Enter Password"
read -s password

URI="mongodb://Spring2018Read:$password@cs125-mongo-01.cs.illinois.edu,cs125-mongo-02.cs.illinois.edu,cs125-mongo-03.cs.illinois.edu/Spring2018?replicaSet=cs125&ssl=true"
mongoexport --uri="$URI" -c state -o fixtures/state.json && \
mongoexport --uri="$URI" -c people -o fixtures/people.json && \
mongoexport --uri="$URI" -c peopleChanges -o fixtures/peopleChanges.json && \
mongoexport --uri="$URI" -c enrollment -o fixtures/enrollment.json

URL="127.0.0.1:27017"
mongoimport --drop -h "$URL" -d cs125 -c state fixtures/state.json && \
mongoimport --drop -h "$URL" -d cs125 -c people fixtures/people.json && \
mongoimport --drop -h "$URL" -d cs125 -c peopleChanges fixtures/peopleChanges.json && \
mongoimport --drop -h "$URL" -d cs125 -c enrollment fixtures/enrollment.json
