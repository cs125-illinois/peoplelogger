#!/usr/bin/env bash

echo "Enter Password"
read -s password

URL="127.0.0.1:27017"
mongoexport --uri="$URI" -c state -o fixtures/pushState.json && \
mongoexport --uri="$URI" -c people -o fixtures/pushPeople.json && \
mongoexport --uri="$URI" -c peopleChanges -o fixtures/pushPeopleChanges.json && \
mongoexport --uri="$URI" -c enrollment -o fixtures/pushEnrollment.json
mongoexport --uri="$URI" -c photos -o fixtures/pushPhotos.json

URI="mongodb://cs125:$password@cs125-mongo-01.cs.illinois.edu,cs125-mongo-02.cs.illinois.edu,cs125-mongo-03.cs.illinois.edu/cs125?replicaSet=cs125&ssl=true"
mongoimport --drop -h "$URL" -d cs125 -c state fixtures/pushState.json && \
mongoimport --drop -h "$URL" -d cs125 -c people fixtures/pushPeople.json && \
mongoimport --drop -h "$URL" -d cs125 -c peopleChanges fixtures/pushPeopleChanges.json && \
mongoimport --drop -h "$URL" -d cs125 -c enrollment fixtures/pushEnrollment.json
mongoimport --drop -h "$URL" -d cs125 -c photos fixtures/pushPhotos.json && \
