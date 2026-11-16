import { readFileSync } from 'node:fs';
import { WorkerLink } from './link.mjs';

const configFile = process.argv[2];
if (!configFile) {
  console.error('Usage: node apps/link/start.mjs <config.json>');
  process.exitCode = 1;
} else {
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    await new WorkerLink(config, process.env.SUPERAGENT_WORKER_TOKEN).start(shutdown.signal);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
