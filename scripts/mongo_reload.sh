#!/usr/bin/env bash

URL="127.0.0.1:27017"
mongoimport --drop -h "$URL" -d cs125 -c state fixtures/state.json && \
mongoimport --drop -h "$URL" -d cs125 -c people fixtures/people.json && \
mongoimport --drop -h "$URL" -d cs125 -c peopleChanges fixtures/peopleChanges.json && \
mongoimport --drop -h "$URL" -d cs125 -c enrollment fixtures/enrollment.json
