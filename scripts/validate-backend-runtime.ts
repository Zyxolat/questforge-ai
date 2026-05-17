/**
 * QuestForge AI - Backend Runtime Validation
 *
 * Starts the built backend in a child process, validates startup behavior,
 * verifies the exported health endpoints, and confirms graceful shutdown.
 *
 * Usage:
 *   npm run validate:backend-runtime
 *   BACKEND_ENV_FILE=backend/.env npm run validate:backend-runtime
 */

import { spawn } from 'child_process';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

type RuntimeStatus = 'healthy' | 'degraded' | 'unhealthy';

type RuntimeCheck = {
  name: string;
  status: RuntimeStatus;
  message: string;
  details?: unknown;
  responseTime?: number;
};

type StartupState = {
  servicesReady?: boolean;
  isInitializing?: boolean;
  initializationAttempts?: number;
  lastStartedAt?: string | null;
  lastReadyAt?: string | null;
  lastError?: string | null;
};

type HealthPayload = {
  ok?: boolean;
  ready?: boolean;
  startup?: StartupState;
  healthy?: boolean;
  checks?: Record<string, unknown>;
  [key: string]: unknown;
};

type FetchResult = {
  status: number;
  data: HealthPayload | null;
  text: string;
  duration: number;
};

type SpawnedBackend = {
  child: ReturnType<typeof spawn>;
  stdout: string[];
  stderr: string[];
  exitCodePromise: Promise<number | null>;
};

const checks: RuntimeCheck[] = [];

function recordCheck(
  name: string,
  status: RuntimeStatus,
  message: string,
  details?: unknown,
  responseTime?: number
) {
  checks.push({ name, status, message, details, responseTime });
  const icon = status === 'healthy' ? '✓' : status === 'degraded' ? '⚠️' : '❌';
  const color = status === 'healthy' ? '\x1b[32m' : status === 'degraded' ? '\x1b[33m' : '\x1b[31m';
  const timing = typeof responseTime === 'number' ? ` [${responseTime}ms]` : '';
  console.log(`${color}${icon} ${name}${timing}: ${message}\x1b[0m`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveEnvFile() {
  const explicit = process.env.BACKEND_ENV_FILE?.trim();
  const candidates = explicit
    ? [explicit]
    : [path.join(process.cwd(), 'backend/.env'), path.join(process.cwd(), '.env.production')];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function loadRuntimeEnv() {
  const envFile = resolveEnvFile();
  const parsed = envFile ? dotenv.parse(fs.readFileSync(envFile)) : {};

  return {
    envFile,
    env: {
      ...process.env,
      ...parsed
    },
    port: Number(parsed.PORT || process.env.PORT || '4000')
  };
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<FetchResult> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data: HealthPayload | null = null;

  try {
    const parsed = JSON.parse(text) as unknown;
    data = isRecord(parsed) ? (parsed as HealthPayload) : null;
  } catch {
    // Ignore invalid JSON and fall back to the raw response text.
  }

  return {
    status: response.status,
    data,
    text,
    duration: Date.now() - startedAt
  };
}

function spawnBackend(env: NodeJS.ProcessEnv, extraEnv?: Record<string, string>): SpawnedBackend {
  const backendDir = path.join(process.cwd(), 'backend');
  const stdout: string[] = [];
  const stderr: string[] = [];

  const child = spawn('node', ['dist/index.js'], {
    cwd: backendDir,
    env: {
      ...env,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout?.on('data', (chunk) => {
    stdout.push(chunk.toString());
  });
  child.stderr?.on('data', (chunk) => {
    stderr.push(chunk.toString());
  });

  const exitCodePromise = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  return { child, stdout, stderr, exitCodePromise };
}

async function waitForServer(baseUrl: string, backend: SpawnedBackend, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';

  while (Date.now() < deadline) {
    const exitCode = await Promise.race([
      backend.exitCodePromise,
      sleep(250).then(() => 'running' as const)
    ]);

    if (exitCode !== 'running') {
      throw new Error(
        `Backend exited before health check was reachable (exit code ${String(exitCode)}).`
      );
    }

    try {
      return await fetchJson(`${baseUrl}/health`, 1000);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(500);
    }
  }

  throw new Error(`Backend did not become reachable within ${timeoutMs}ms: ${lastError}`);
}

async function validateMissingEnvFailure(env: NodeJS.ProcessEnv) {
  const backend = spawnBackend(env, { DATABASE_URL: '' });
  const exitCode = await Promise.race([
    backend.exitCodePromise,
    sleep(10000).then(() => null)
  ]);

  const combinedOutput = `${backend.stdout.join('')}\n${backend.stderr.join('')}`;
  if (exitCode === null) {
    backend.child.kill('SIGTERM');
    recordCheck('Missing Env Handling', 'unhealthy', 'Backend did not fail fast when DATABASE_URL was removed');
    return;
  }

  const hasValidationMessage = combinedOutput.includes('[ENV] Startup environment validation failed.');
  const hasUnhandledRejection = /UnhandledPromiseRejection/i.test(combinedOutput);

  if (exitCode === 1 && hasValidationMessage && !hasUnhandledRejection) {
    recordCheck(
      'Missing Env Handling',
      'healthy',
      'Backend rejected missing required env with structured validation output',
      { exitCode }
    );
    return;
  }

  recordCheck(
    'Missing Env Handling',
    'unhealthy',
    'Backend did not surface missing env in the expected safe format',
    {
      exitCode,
      output: combinedOutput.trim()
    }
  );
}

async function validateRunningBackend(baseUrl: string, backend: SpawnedBackend) {
  const initialHealth = await waitForServer(baseUrl, backend, 15000);

  if (initialHealth.status === 200 && initialHealth.data?.ok === true) {
    recordCheck(
      'Health Endpoint',
      'healthy',
      'GET /health returned a healthy payload',
      initialHealth.data?.startup,
      initialHealth.duration
    );
  } else {
    recordCheck(
      'Health Endpoint',
      'unhealthy',
      `GET /health returned unexpected status ${initialHealth.status}`,
      initialHealth.data ?? initialHealth.text,
      initialHealth.duration
    );
  }

  const rootResponse = await fetchJson(baseUrl, 5000);
  if (rootResponse.status === 200) {
    recordCheck('Root Endpoint', 'healthy', 'GET / returned 200', rootResponse.data ?? rootResponse.text, rootResponse.duration);
  } else {
    recordCheck(
      'Root Endpoint',
      'unhealthy',
      `GET / returned unexpected status ${rootResponse.status}`,
      rootResponse.data ?? rootResponse.text,
      rootResponse.duration
    );
  }

  let readyResult: FetchResult | null = null;
  let readyError: string | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      readyResult = await fetchJson(`${baseUrl}/health/ready`, 15000);
      readyError = null;
      if (readyResult.status === 200 && readyResult.data?.ready === true) {
        break;
      }
    } catch (error) {
      readyError = error instanceof Error ? error.message : String(error);
    }
    await sleep(2000);
  }

  if (readyResult && readyResult.status === 200 && readyResult.data?.ready === true) {
    recordCheck(
      'Readiness Endpoint',
      'healthy',
      'GET /health/ready returned ready=true',
      readyResult.data,
      readyResult.duration
    );
  } else {
    recordCheck(
      'Readiness Endpoint',
      'unhealthy',
      readyError
        ? `GET /health/ready timed out or failed: ${readyError}`
        : `GET /health/ready did not become ready (last status ${readyResult?.status ?? 'n/a'})`,
      readyResult?.data ?? readyResult?.text ?? readyError,
      readyResult?.duration
    );
  }

  try {
    const protectedResponse = await fetch(`${baseUrl}/api/quests/active`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });

    if (protectedResponse.status === 401) {
      recordCheck('Protected Route Auth', 'healthy', 'Protected API route rejects anonymous access with 401');
    } else {
      recordCheck(
        'Protected Route Auth',
        'degraded',
        `Protected API route returned ${protectedResponse.status} instead of 401`
      );
    }
  } catch (error) {
    recordCheck(
      'Protected Route Auth',
      'unhealthy',
      `Protected API route check failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const combinedOutput = `${backend.stdout.join('')}\n${backend.stderr.join('')}`;
  if (/UnhandledPromiseRejection/i.test(combinedOutput)) {
    recordCheck('Unhandled Rejections', 'unhealthy', 'Detected unhandled promise rejection in backend output');
  } else {
    recordCheck('Unhandled Rejections', 'healthy', 'No unhandled promise rejections detected in backend output');
  }
}

async function shutdownBackend(backend: SpawnedBackend) {
  backend.child.kill('SIGTERM');
  const exitCode = await Promise.race([
    backend.exitCodePromise,
    sleep(10000).then(() => null)
  ]);

  if (exitCode === 0) {
    recordCheck('Graceful Shutdown', 'healthy', 'Backend exited cleanly on SIGTERM', { exitCode });
    return;
  }

  recordCheck('Graceful Shutdown', 'unhealthy', 'Backend did not exit cleanly on SIGTERM', { exitCode });
}

async function main() {
  const { envFile, env, port } = loadRuntimeEnv();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║          QuestForge AI - Backend Runtime Validation         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log(`Using env file: ${envFile ?? 'process environment only'}`);
  console.log(`Testing backend on: ${baseUrl}\n`);

  await validateMissingEnvFailure(env);

  const backend = spawnBackend(env);

  try {
    await validateRunningBackend(baseUrl, backend);
  } finally {
    if (!backend.child.killed) {
      await shutdownBackend(backend);
    }
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    RUNTIME SUMMARY                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const healthy = checks.filter((check) => check.status === 'healthy').length;
  const degraded = checks.filter((check) => check.status === 'degraded').length;
  const unhealthy = checks.filter((check) => check.status === 'unhealthy').length;

  console.log(`✓ Healthy:    ${healthy}`);
  console.log(`⚠️  Degraded:   ${degraded}`);
  console.log(`❌ Unhealthy:  ${unhealthy}\n`);

  if (unhealthy === 0) {
    process.exit(0);
  }

  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`❌ Runtime validation failed: ${message}`);
  process.exit(1);
});
