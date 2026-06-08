import { spawn } from 'child_process';
import * as path from 'path';

async function runValidationAttempt(attempt: number): Promise<number> {
  console.log(`\n=== Gameplay validation run ${attempt} ===`);

  const scriptPath = path.join(process.cwd(), 'scripts', 'validate-gameplay.ts');
  const child = spawn('npx', ['ts-node', scriptPath], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'inherit'
  });

  return new Promise((resolve) => {
    child.once('exit', (code) => {
      resolve(code === null ? 1 : code);
    });
  });
}

async function main() {
  const results: number[] = [];

  results.push(await runValidationAttempt(1));
  results.push(await runValidationAttempt(2));

  console.log('\n=== Gameplay validation summary ===');
  results.forEach((exitCode, index) => {
    console.log(`Run ${index + 1}: ${exitCode === 0 ? 'PASS' : 'FAIL'} (${exitCode})`);
  });

  const failed = results.filter((code) => code !== 0).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Gameplay replay failed', error);
  process.exit(1);
});
