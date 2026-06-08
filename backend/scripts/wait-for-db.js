#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const workspaceRoot = path.resolve(__dirname, '..');
const envPath = path.join(workspaceRoot, '.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const databaseUrl = process.env.DATABASE_URL;
const maxAttempts = Number(process.env.DB_READY_ATTEMPTS || 30);
const retryDelayMs = Number(process.env.DB_READY_RETRY_MS || 2000);

if (!databaseUrl) {
  console.error('[WAIT-FOR-DB] ERROR: DATABASE_URL is not set. Load your local .env or export DATABASE_URL first.');
  process.exit(1);
}

async function checkConnection(attempt) {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    console.log('[WAIT-FOR-DB] Database connection established.');
    process.exit(0);
  } catch (error) {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[WAIT-FOR-DB] Attempt ${attempt}/${maxAttempts} failed: ${message}`);
    if (attempt >= maxAttempts) {
      console.error('[WAIT-FOR-DB] Database did not become available within the retry window.');
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return checkConnection(attempt + 1);
  }
}

checkConnection(1);
