// npm test: the whole .NET suite against a throwaway PostgreSQL (or DATABASE_URL, to test against a server you choose).
// Extra arguments go to `dotnet test`, e.g. `npm test -- --filter GuestJourneyTests`.
import { spawn } from 'node:child_process';
import { startPostgres } from './postgres.mjs';

const run = (cmd, args, env) => new Promise(resolve => {
  const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', code => resolve(code ?? 1));
});

let db = null;
let url = process.env.DATABASE_URL;
if (!url) {
  db = await startPostgres();
  url = db.url;
}
let code = 1;
try {
  code = await run('dotnet', ['test', 'backend/Encore.Api.Tests', '--nologo', ...process.argv.slice(2)], {
    DATABASE_URL: url, ENCORE_SKIP_DOTENV: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1',
  });
} finally {
  if (db) await db.stop();
}
process.exit(code);
