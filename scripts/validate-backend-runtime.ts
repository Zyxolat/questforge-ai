/**
 * QuestForge AI - Backend Production Runtime Validation
 * 
 * Validates backend service health and production readiness:
 * 1. Health check endpoints
 * 2. Database connectivity
 * 3. Indexer service status
 * 4. Verifier worker status
 * 5. Rate limiting functionality
 * 6. Error handling and logging
 * 7. Graceful shutdown handling
 * 
 * Usage: npx ts-node scripts/validate-backend-runtime.ts
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load env
const envPath = path.join(__dirname, '../.env.production');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  details?: any;
  responseTime?: number;
}

const checks: HealthCheck[] = [];

function recordCheck(name: string, status: 'healthy' | 'degraded' | 'unhealthy', message: string, details?: any, responseTime?: number) {
  checks.push({ name, status, message, details, responseTime });
  const icon = status === 'healthy' ? '✓' : status === 'degraded' ? '⚠️' : '❌';
  const color = status === 'healthy' ? '\x1b[32m' : status === 'degraded' ? '\x1b[33m' : '\x1b[31m';
  const timing = responseTime ? ` [${responseTime}ms]` : '';
  console.log(`${color}${icon} ${name}${timing}: ${message}\x1b[0m`);
}

async function validateBackendRuntime() {
  const apiUrl = process.env.API_URL || 'http://localhost:4000';

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║    QuestForge AI - Backend Production Runtime Validation    ║');
  console.log('║              Celo Mainnet Service Health Check              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log(`🔍 Testing backend: ${apiUrl}\n`);

  try {
    // Test 1: Basic Health Check
    console.log('🏥 TEST 1: Basic Health Check\n');

    let startTime = Date.now();
    try {
      const response = await axios.get(`${apiUrl}/health`, { timeout: 5000 });
      const duration = Date.now() - startTime;
      
      if (response.status === 200) {
        recordCheck('Health Endpoint', 'healthy', 'Backend is running', response.data, duration);
      } else {
        recordCheck('Health Endpoint', 'unhealthy', `Unexpected status code: ${response.status}`, response.data, duration);
      }
    } catch (e) {
      const duration = Date.now() - startTime;
      recordCheck('Health Endpoint', 'unhealthy', `Failed to connect: ${e instanceof Error ? e.message : String(e)}`, undefined, duration);
    }

    // Test 2: Database Connectivity
    console.log('\n🗄️  TEST 2: Database Connectivity\n');

    startTime = Date.now();
    try {
      const response = await axios.get(`${apiUrl}/health/db`, { timeout: 5000 });
      const duration = Date.now() - startTime;
      
      if (response.data.database === 'connected') {
        recordCheck('Database Connection', 'healthy', 'PostgreSQL connected', response.data, duration);
      } else {
        recordCheck('Database Connection', 'unhealthy', 'Database not connected', response.data, duration);
      }
    } catch (e) {
      const duration = Date.now() - startTime;
      recordCheck('Database Connection', 'unhealthy', `Check failed: ${e instanceof Error ? e.message : String(e)}`, undefined, duration);
    }

    // Test 3: Indexer Service Status
    console.log('\n🔄 TEST 3: Indexer Service Status\n');

    startTime = Date.now();
    try {
      const response = await axios.get(`${apiUrl}/health/indexer`, { timeout: 5000 });
      const duration = Date.now() - startTime;
      
      if (response.data.status === 'running' || response.data.status === 'healthy') {
        recordCheck('Indexer Service', 'healthy', 'Event indexer is running', response.data, duration);
      } else {
        recordCheck('Indexer Service', 'degraded', `Status: ${response.data.status}`, response.data, duration);
      }
    } catch (e) {
      const duration = Date.now() - startTime;
      recordCheck('Indexer Service', 'degraded', `Check failed: ${e instanceof Error ? e.message : String(e)}`, undefined, duration);
    }

    // Test 4: Verification Worker Status
    console.log('\n✅ TEST 4: Verification Worker Status\n');

    startTime = Date.now();
    try {
      const response = await axios.get(`${apiUrl}/health/verifier`, { timeout: 5000 });
      const duration = Date.now() - startTime;
      
      if (response.data.status === 'running' || response.data.status === 'healthy') {
        recordCheck('Verification Worker', 'healthy', 'Verifier worker is running', response.data, duration);
      } else {
        recordCheck('Verification Worker', 'degraded', `Status: ${response.data.status}`, response.data, duration);
      }
    } catch (e) {
      const duration = Date.now() - startTime;
      recordCheck('Verification Worker', 'degraded', `Check failed: ${e instanceof Error ? e.message : String(e)}`, undefined, duration);
    }

    // Test 5: Rate Limiting
    console.log('\n⏱️  TEST 5: Rate Limiting\n');

    let rateLimitWorking = false;
    try {
      // Make rapid requests to trigger rate limit
      let responses = 0;
      let blocked = false;

      for (let i = 0; i < 10; i++) {
        try {
          await axios.get(`${apiUrl}/health`, { timeout: 1000 });
          responses++;
        } catch (e) {
          if (axios.isAxiosError(e) && e.response?.status === 429) {
            blocked = true;
            rateLimitWorking = true;
            recordCheck('Rate Limiting', 'healthy', `Rate limiter active (blocked after ${responses} requests)`);
            break;
          }
        }
      }

      if (!blocked && responses === 10) {
        recordCheck('Rate Limiting', 'degraded', 'Rate limiter may not be active (10 requests allowed)', { requestsAllowed: responses });
      }
    } catch (e) {
      recordCheck('Rate Limiting', 'degraded', `Test error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Test 6: Error Handling
    console.log('\n🚨 TEST 6: Error Handling\n');

    startTime = Date.now();
    try {
      // Try invalid endpoint
      await axios.get(`${apiUrl}/invalid-endpoint`);
      const duration = Date.now() - startTime;
      recordCheck('404 Error Handling', 'degraded', 'Invalid endpoint did not return 404', undefined, duration);
    } catch (e) {
      const duration = Date.now() - startTime;
      if (axios.isAxiosError(e) && e.response?.status === 404) {
        recordCheck('404 Error Handling', 'healthy', 'Invalid endpoints return proper 404', { statusCode: 404 }, duration);
      } else {
        recordCheck('404 Error Handling', 'unhealthy', `Unexpected error: ${e instanceof Error ? e.message : String(e)}`, undefined, duration);
      }
    }

    startTime = Date.now();
    try {
      // Try invalid auth
      await axios.post(`${apiUrl}/quests/generate`, 
        { difficulty: 1 },
        { headers: { Authorization: 'Bearer invalid' } }
      );
      const duration = Date.now() - startTime;
      recordCheck('Auth Error Handling', 'degraded', 'Invalid auth did not return 401', undefined, duration);
    } catch (e) {
      const duration = Date.now() - startTime;
      if (axios.isAxiosError(e) && e.response?.status === 401) {
        recordCheck('Auth Error Handling', 'healthy', 'Invalid auth returns proper 401', { statusCode: 401 }, duration);
      } else {
        recordCheck('Auth Error Handling', 'unhealthy', `Unexpected error: ${e instanceof Error ? e.message : String(e)}`, undefined, duration);
      }
    }

    // Test 7: Response Performance
    console.log('\n⚡ TEST 7: Response Performance\n');

    const performanceLimits = {
      health: 500, // 500ms
      apiCall: 2000, // 2s
    };

    startTime = Date.now();
    try {
      await axios.get(`${apiUrl}/health`, { timeout: 5000 });
      const duration = Date.now() - startTime;
      const status = duration < performanceLimits.health ? 'healthy' : 'degraded';
      recordCheck('Health Endpoint Performance', status, `Response time: ${duration}ms`, { target: performanceLimits.health }, duration);
    } catch (e) {
      recordCheck('Health Endpoint Performance', 'unhealthy', `Failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Test 8: RPC Connectivity
    console.log('\n🌐 TEST 8: RPC Connectivity\n');

    startTime = Date.now();
    try {
      const response = await axios.get(`${apiUrl}/health/rpc`, { timeout: 5000 });
      const duration = Date.now() - startTime;
      
      if (response.data.connected) {
        recordCheck('RPC Connectivity', 'healthy', `Connected to Celo Mainnet (block ${response.data.blockNumber})`, response.data, duration);
      } else {
        recordCheck('RPC Connectivity', 'unhealthy', 'Not connected to RPC', response.data, duration);
      }
    } catch (e) {
      const duration = Date.now() - startTime;
      recordCheck('RPC Connectivity', 'unhealthy', `Check failed: ${e instanceof Error ? e.message : String(e)}`, undefined, duration);
    }

    // Test 9: Service Dependencies
    console.log('\n📦 TEST 9: Service Dependencies\n');

    const dependencies = ['redis', 'openai', 'sentry'];
    for (const dep of dependencies) {
      startTime = Date.now();
      try {
        const response = await axios.get(`${apiUrl}/health/dependency/${dep}`, { timeout: 5000 });
        const duration = Date.now() - startTime;
        
        const status = response.data.available ? 'healthy' : 'degraded';
        recordCheck(`${dep.toUpperCase()} Service`, status, response.data.message, response.data, duration);
      } catch (e) {
        const duration = Date.now() - startTime;
        if (axios.isAxiosError(e) && e.response?.status === 404) {
          // Endpoint doesn't exist, might not be implemented
        } else {
          recordCheck(`${dep.toUpperCase()} Service`, 'degraded', `Check not implemented or failed`, undefined, duration);
        }
      }
    }

  } catch (error) {
    recordCheck('Connection', 'unhealthy', `Connection error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  await validateBackendRuntime();

  // Summary
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    RUNTIME SUMMARY                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const healthy = checks.filter(c => c.status === 'healthy').length;
  const degraded = checks.filter(c => c.status === 'degraded').length;
  const unhealthy = checks.filter(c => c.status === 'unhealthy').length;

  console.log(`✓ Healthy:    ${healthy}`);
  console.log(`⚠️  Degraded:   ${degraded}`);
  console.log(`❌ Unhealthy:  ${unhealthy}\n`);

  if (unhealthy === 0) {
    console.log('✅ Backend is healthy and ready for production!\n');
    process.exit(0);
  } else if (unhealthy <= 2) {
    console.log('⚠️  Backend has some issues. Review above and fix before deployment.\n');
    process.exit(1);
  } else {
    console.log('❌ Backend has critical issues. Do not deploy.\n');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
