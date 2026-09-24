// Development: the .NET API plus one Vite dev server per app, with hot reload for the screens.
// Uses DATABASE_URL from .env when set; otherwise a private PostgreSQL kept in data/postgres.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPostgres } from './scripts/postgres.mjs';

const adminDev = process.env.ADMIN_DEV_PORT || '5173';
const guestDev = process.env.GUEST_DEV_PORT || '5174';
const apiPort = process.env.ENCORE_API_PORT || '8080';
const configured = process.env.DATABASE_URL
  || (existsSync('.env') && readFileSync('.env', 'utf8').split('\n').some(l => /^\s*DATABASE_URL\s*=\s*\S/.test(l)));

let db = null;
const env = {};
if (!configured) {
  db = await startPostgres({ dir: join(process.env.ENCORE_DATA || 'data', 'postgres') });
  env.DATABASE_URL = db.url;
}

const children = [];
let closing = false;
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  children.forEach(c => c.kill());
  if (db) await db.stop();
  process.exit(code);
}
function run(cmd, args, extra) {
  const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env, ...extra } });
  child.on('exit', code => stop(code ?? 0));
  children.push(child);
}

// Each dev server is its own origin, so the API is told which origins may send it requests.
run('dotnet', ['run', '--project', 'backend/Encore.Api'], {
  PORT: apiPort, ADMIN_ORIGIN: `http://127.0.0.1:${adminDev}`, GUEST_ORIGIN: `http://127.0.0.1:${guestDev}`,
  ASPNETCORE_ENVIRONMENT: 'Development', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1',
});
const vite = 'node_modules/vite/bin/vite.js';
run(process.execPath, [vite, '--port', adminDev, '--strictPort'], { ENCORE_APP: 'admin', ENCORE_API_PORT: apiPort });
run(process.execPath, [vite, '--port', guestDev, '--strictPort'], { ENCORE_APP: 'guest', ENCORE_API_PORT: apiPort });
console.log(`Encore dev — admin: http://127.0.0.1:${adminDev}/admin  guest: http://127.0.0.1:${guestDev}/  API + Swagger: http://127.0.0.1:${apiPort}/swagger`);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
