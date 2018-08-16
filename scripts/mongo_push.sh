#!/usr/bin/env bash

echo "Enter Password"
read -s password

LOCAL="127.0.0.1:27017"
mongoexport --uri="$LOCAL" -c state -o fixtures/pushState.json && \
mongoexport --uri="$LOCAL" -c people -o fixtures/pushPeople.json && \
mongoexport --uri="$LOCAL" -c peopleChanges -o fixtures/pushPeopleChanges.json && \
mongoexport --uri="$LOCAL" -c enrollment -o fixtures/pushEnrollment.json && \
mongoexport --uri="$LOCAL" -c photos -o fixtures/pushPhotos.json

REMOTE="mongodb://cs125:$password@cs125-mongo-01.cs.illinois.edu,cs125-mongo-02.cs.illinois.edu,cs125-mongo-03.cs.illinois.edu/cs125?replicaSet=cs125&ssl=true"
mongoimport --drop -h "$REMOTE" -d cs125 -c state fixtures/pushState.json && \
mongoimport --drop -h "$REMOTE" -d cs125 -c people fixtures/pushPeople.json && \
mongoimport --drop -h "$REMOTE" -d cs125 -c peopleChanges fixtures/pushPeopleChanges.json && \
mongoimport --drop -h "$REMOTE" -d cs125 -c enrollment fixtures/pushEnrollment.json && \
mongoimport --drop -h "$REMOTE" -d cs125 -c photos fixtures/pushPhotos.json
