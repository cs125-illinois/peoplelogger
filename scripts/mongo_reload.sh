#!/usr/bin/env bash

LOCAL="127.0.0.1:27017"
mongo $LOCAL/cs125 --eval "db.photos.drop()"
mongoimport --drop -h "$LOCAL" -d cs125 -c state fixtures/loadState.json && \
mongoimport --drop -h "$LOCAL" -d cs125 -c people fixtures/loadPeople.json && \
mongoimport --drop -h "$LOCAL" -d cs125 -c peopleChanges fixtures/loadPeopleChanges.json && \
mongoimport --drop -h "$LOCAL" -d cs125 -c enrollment fixtures/loadEnrollment.json
