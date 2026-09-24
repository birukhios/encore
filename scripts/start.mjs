// npm start: run Encore on this computer and open the organizer admin.
// Needs PostgreSQL: set DATABASE_URL in .env, or ENCORE_LOCAL_DB=1 to run a private one inside data/postgres.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPostgres } from './postgres.mjs';

// Only the two settings this launcher needs; the API reads .env itself for everything else.
const fromDotEnv = name => {
  if (process.env[name] !== undefined || !existsSync('.env')) return process.env[name];
  const line = readFileSync('.env', 'utf8').split('\n').map(l => l.trim()).find(l => l.startsWith(name + '='));
  return line?.slice(name.length + 1).replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2').trim();
};

if (!existsSync('dist/admin.html') || !existsSync('dist/guest.html')) {
  console.log('The web apps are not built yet. Run: npm run build');
  process.exit(1);
}
let db = null;
const env = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
if (!fromDotEnv('DATABASE_URL') && fromDotEnv('ENCORE_LOCAL_DB') === '1') {
  const dir = join(process.env.ENCORE_DATA || 'data', 'postgres');
  db = await startPostgres({ dir });
  env.DATABASE_URL = db.url;
  console.log('Local PostgreSQL started in ' + dir);
}
const port = fromDotEnv('PORT') || '8080';
const api = spawn('dotnet', ['run', '--project', 'backend/Encore.Api', '-c', 'Release'], { stdio: 'inherit', env: { ...process.env, ...env } });

const stop = async code => {
  api.kill();
  if (db) await db.stop();
  process.exit(code);
};
api.on('exit', code => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

if (!process.argv.includes('--no-browser')) {
  const admin = `http://127.0.0.1:${port}/admin`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
        const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        spawn(open, [admin], { stdio: 'ignore', detached: true }).unref();
        console.log(`Encore organizer admin: ${admin}\nEncore guest app:       http://127.0.0.1:${port}/\nKeep this window open while using Encore. Press Control-C to stop.`);
        break;
      }
    } catch { /* still starting */ }
    await new Promise(r => setTimeout(r, 1000));
  }
}
