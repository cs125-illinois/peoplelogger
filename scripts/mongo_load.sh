#!/usr/bin/env bash

echo "Enter Password"
read -s password

URI="mongodb://Spring2018Read:$password@cs125-mongo-01.cs.illinois.edu,cs125-mongo-02.cs.illinois.edu,cs125-mongo-03.cs.illinois.edu/Spring2018?replicaSet=cs125&ssl=true"
mongoexport --uri="$URI" -c state -o fixtures/loadState.json && \
mongoexport --uri="$URI" -c people -o fixtures/loadPeople.json && \
mongoexport --uri="$URI" -c peopleChanges -o fixtures/loadPeopleChanges.json && \
mongoexport --uri="$URI" -c enrollment -o fixtures/loadEnrollment.json

URL="127.0.0.1:27017"
mongo $URL/cs125 --eval "db.photos.drop()"
mongoimport --drop -h "$URL" -d cs125 -c state fixtures/loadState.json && \
mongoimport --drop -h "$URL" -d cs125 -c people fixtures/loadPeople.json && \
mongoimport --drop -h "$URL" -d cs125 -c peopleChanges fixtures/loadPeopleChanges.json && \
mongoimport --drop -h "$URL" -d cs125 -c enrollment fixtures/loadEnrollment.json
