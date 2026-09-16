// Development: Python API (admin 8081, guest 8082) plus one Vite dev server per app.
import { spawn } from 'node:child_process';

const adminDev = process.env.ADMIN_DEV_PORT || '5173';
const guestDev = process.env.GUEST_DEV_PORT || '5174';
const children = [];
function run(cmd, args, env) {
  const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', code => stop(code ?? 0));
  children.push(child);
}
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  children.forEach(c => c.kill());
  process.exit(code);
}
run(process.env.ENCORE_PYTHON || 'python3', ['launch.py', '--no-browser'], {
  ADMIN_ORIGIN: `http://127.0.0.1:${adminDev}`, GUEST_ORIGIN: `http://127.0.0.1:${guestDev}`,
});
const vite = 'node_modules/vite/bin/vite.js';
run(process.execPath, [vite, '--port', adminDev, '--strictPort'], { ENCORE_APP: 'admin' });
run(process.execPath, [vite, '--port', guestDev, '--strictPort'], { ENCORE_APP: 'guest' });
console.log(`Encore dev — admin: http://127.0.0.1:${adminDev}/admin  guest: http://127.0.0.1:${guestDev}/`);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
