#!/bin/bash
set -e

echo "[ENTRYPOINT] Starting QuestForge AI Backend"
echo "[ENTRYPOINT] Running database migrations..."

# Run Prisma migrations
npm run prisma:migrate:deploy

if [ $? -eq 0 ]; then
  echo "[ENTRYPOINT] Migrations completed successfully"
else
  echo "[ENTRYPOINT] Migration failed!"
  exit 1
fi

echo "[ENTRYPOINT] Starting server..."
npm start
