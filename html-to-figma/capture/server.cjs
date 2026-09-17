const http = require('node:http');
const crypto = require('node:crypto');
const { capture } = require('./browser.cjs');
function createServer({ token = crypto.randomBytes(24).toString('hex'), capturePage = capture } = {}) {
  let busy = false;
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = !origin || origin === 'null' || origin === 'https://www.figma.com' || origin === 'https://figma.com' || origin === 'http://127.0.0.1:3847';
    res.setHeader('Vary', 'Origin');
    if (!allowed) { res.writeHead(403); return res.end('Origin not allowed'); }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Capture-Token');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url !== '/capture' || req.method !== 'POST') return send(404, { error: 'Use POST /capture from the plugin.' });
    if (req.headers['x-capture-token'] !== token) return send(401, { error: 'Paste the connection token printed by the capture companion.' });
    if (busy) return send(409, { error: 'A capture is already running. Try again when it finishes.' });
    busy = true;
    try {
      let size = 0, body = '';
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 6 * 1024 * 1024) { send(413, { error: 'Request exceeds 6 MB.' }); return; }
        body += chunk;
      }
      const result = await capturePage(JSON.parse(body));
      send(200, result);
    } catch (error) { send(400, { error: error.message }); }
    finally { busy = false; }
  });
  server.requestTimeout = 180000;
  return { server, token };
}
if (require.main === module) {
  const { server, token } = createServer();
  server.listen(3847, '127.0.0.1', () => {
    console.log('\nHTML & Websites → Figma capture companion\nLocal endpoint: http://127.0.0.1:3847\nConnection token (paste into the plugin):\n' + token + '\n\nKeep this terminal open. Ctrl+C stops the companion.\n');
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createServer };
