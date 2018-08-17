#!/usr/bin/env bash

LOCAL="mongodb://127.0.0.1:27017/cs125"
mongo $LOCAL --eval "db.photos.drop() && db.discourse.drop()"
mongoimport --drop --uri="$LOCAL" -c state fixtures/loadState.json && \
mongoimport --drop --uri="$LOCAL" -c people fixtures/loadPeople.json && \
mongoimport --drop --uri="$LOCAL" -c peopleChanges fixtures/loadPeopleChanges.json && \
mongoimport --drop --uri="$LOCAL" -c enrollment fixtures/loadEnrollment.json
