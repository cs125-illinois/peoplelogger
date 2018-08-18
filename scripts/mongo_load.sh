#!/usr/bin/env bash

echo "Enter Password"
read -s password

REMOTE="mongodb://Spring2018Read:$password@cs125-mongo-01.cs.illinois.edu,cs125-mongo-02.cs.illinois.edu,cs125-mongo-03.cs.illinois.edu/Spring2018?replicaSet=cs125&ssl=true"
mongoexport --uri="$REMOTE" -c state -o fixtures/loadState.json && \
mongoexport --uri="$REMOTE" -c people -o fixtures/loadPeople.json && \
mongoexport --uri="$REMOTE" -c peopleChanges -o fixtures/loadPeopleChanges.json && \
mongoexport --uri="$REMOTE" -c enrollment -o fixtures/loadEnrollment.json

LOCAL="mongodb://127.0.0.1:27017/cs125"
mongo $LOCAL --eval "db.photos.drop() && db.discourseUsers.drop() && db.discourseUserChanges.drop()"
mongoimport --drop --uri="$LOCAL" -c state fixtures/loadState.json && \
mongoimport --drop --uri="$LOCAL" -c people fixtures/loadPeople.json && \
mongoimport --drop --uri="$LOCAL" -c peopleChanges fixtures/loadPeopleChanges.json && \
mongoimport --drop --uri="$LOCAL" -c enrollment fixtures/loadEnrollment.json
