#!/bin/sh
# Container start: apply migrations, seed only if the database is empty, then start the API.
# (With RUN_WORKER=true the API process also runs the BullMQ worker and Telegram.)
set -e
npx prisma migrate deploy
node dist/prisma/seed.js --if-empty
exec node dist/src/server.js
