// A private PostgreSQL for tests and local development, so neither needs a database installed.
// Production always uses DATABASE_URL (Render's managed PostgreSQL); this is never used there.
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/**
 * Start PostgreSQL. `dir` keeps data between runs (development); omit it for a throwaway database (tests).
 * Returns { url, stop }.
 */
export async function startPostgres({ dir } = {}) {
  const throwaway = !dir;
  const databaseDir = dir || join(mkdtempSync(join(tmpdir(), 'encore-pg-')), 'data');
  const port = await freePort();
  // The password only guards a loopback-only server that lives as long as this process.
  const password = 'encore-local';
  const pg = new EmbeddedPostgres({ databaseDir, port, user: 'encore', password, persistent: !throwaway, onLog: () => {} });
  if (!existsSync(join(databaseDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  const url = `postgresql://encore:${password}@127.0.0.1:${port}/postgres`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await pg.stop();
    if (throwaway) rmSync(join(databaseDir, '..'), { recursive: true, force: true });
  };
  return { url, stop };
}
