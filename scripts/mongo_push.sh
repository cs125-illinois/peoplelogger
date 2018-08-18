#!/usr/bin/env bash

echo "Enter Password"
read -s password

LOCAL="mongodb://127.0.0.1:27017/cs125"
mongoexport --uri="$LOCAL" -c state -o fixtures/pushState.json && \
mongoexport --uri="$LOCAL" -c people -o fixtures/pushPeople.json && \
mongoexport --uri="$LOCAL" -c peopleChanges -o fixtures/pushPeopleChanges.json && \
mongoexport --uri="$LOCAL" -c enrollment -o fixtures/pushEnrollment.json && \
mongoexport --uri="$LOCAL" -c photos -o fixtures/pushPhotos.json && \
mongoexport --uri="$LOCAL" -c discourseUsers -o fixtures/pushDiscourseUsers.json &&
mongoexport --uri="$LOCAL" -c discourseUserChanges -o fixtures/pushDiscourseUserChanges.json

REMOTE="mongodb://cs125:$password@cs125-mongo-01.cs.illinois.edu,cs125-mongo-02.cs.illinois.edu,cs125-mongo-03.cs.illinois.edu/cs125?replicaSet=cs125&ssl=true"
mongoimport --drop --uri="$REMOTE" -c state fixtures/pushState.json && \
mongoimport --drop --uri="$REMOTE" -c people fixtures/pushPeople.json && \
mongoimport --drop --uri="$REMOTE" -c peopleChanges fixtures/pushPeopleChanges.json && \
mongoimport --drop --uri="$REMOTE" -c enrollment fixtures/pushEnrollment.json && \
mongoimport --drop --uri="$REMOTE" -c photos fixtures/pushPhotos.json && \
mongoimport --drop --uri="$REMOTE" -c discourseUsers fixtures/pushDiscourseUsers.json && \
mongoimport --drop --uri="$REMOTE" -c discourseUserChanges fixtures/pushDiscourseUserChanges.json
