const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const extractor = fs.readFileSync(path.join(__dirname, 'extractor.js'), 'utf8');
const LIMITS = { height: 16000, nodes: 10000, assets: 180, bytes: 60 * 1024 * 1024 };
function integer(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return n;
}
function validate(input) {
  if (!input || typeof input !== 'object') throw new Error('Capture options are required.');
  if (!!input.url === !!input.html) throw new Error('Provide a website URL or HTML, not both.');
  const out = { ...input };
  for (const key of ['url', 'baseUrl']) if (out[key]) {
    const u = new URL(out[key]);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Use an HTTP(S) URL without credentials.');
    out[key] = u.href;
  }
  if (out.html && (typeof out.html !== 'string' || Buffer.byteLength(out.html) > 5 * 1024 * 1024)) throw new Error('HTML must be under 5 MB.');
  out.width = integer(out.width, 1440, 320, 2560, 'Width');
  out.height = integer(out.height, 900, 320, 1600, 'Height');
  out.waitMs = integer(out.waitMs, 800, 0, 10000, 'Wait');
  out.samples = integer(out.samples, 1, 1, 8, 'Motion samples');
  out.durationMs = integer(out.durationMs, 1200, 100, 10000, 'Motion duration');
  out.fullPage = out.fullPage !== false;
  if (out.hover && (typeof out.hover !== 'string' || out.hover.length > 500)) throw new Error('Invalid hover selector.');
  return out;
}
async function launch() {
  const options = { headless: true };
  if (process.env.CHROME_PATH) options.executablePath = process.env.CHROME_PATH;
  else if (process.platform === 'darwin' && fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) options.channel = 'chrome';
  return chromium.launch(options);
}
async function capture(input, onProgress = () => {}) {
  const opts = validate(input);
  const browser = await launch();
  try { return await captureInBrowser(browser, opts, onProgress); }
  finally { await browser.close(); }
}
async function captureInBrowser(browser, input, onProgress = () => {}) {
  const opts = validate(input);
  const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'no-preference' });
  const warnings = [];
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('dialog', dialog => dialog.dismiss());
  // Captures use an isolated browser, with no personal cookies or local filesystem access.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['http:', 'https:', 'data:', 'blob:', 'about:'].includes(url.protocol)) return route.abort();
    return route.continue();
  });
  page.on('requestfailed', request => {
    if (warnings.length < 20) warnings.push(`Resource failed: ${request.url().split('?')[0].slice(0, 160)}`);
  });
  try {
    onProgress('Loading in Chromium…');
    if (opts.url) {
      const response = await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response && response.status() >= 400) throw new Error(`Website returned HTTP ${response.status()}.`);
    } else {
      let html = opts.html;
      if (opts.baseUrl) {
        const base = `<base href="${opts.baseUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + base) : base + html;
      }
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await page.waitForTimeout(opts.waitMs);
    await page.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 5000))]);
      await Promise.all(Array.from(document.images, image => Promise.race([image.decode().catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))])));
    });
    if (opts.fullPage) {
      // Trigger lazy assets without clicking controls or submitting forms. Bounded for infinite feeds.
      for (let y = 0; y < LIMITS.height; y += opts.height) {
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        if (y >= height) break;
        await page.evaluate(y => window.scrollTo(0, y), y);
        await page.waitForTimeout(60);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
    }
    await page.evaluate(source => (0, eval)(source), extractor);
    const meta = await page.evaluate(({ maxHeight, fullPage }) => {
      const all = Array.from(document.querySelectorAll('*'));
      all.forEach((el, index) => el.setAttribute('data-h2f-key', String(index)));
      // Pause at a deterministic start without deleting animation styles/keyframes.
      window.__h2fAnimations = document.getAnimations();
      const animations = window.__h2fAnimations.map(animation => {
        const target = animation.effect && animation.effect.target;
        const timing = animation.effect && animation.effect.getTiming();
        animation.pause();
        return { key: target && target.getAttribute('data-h2f-key'), name: animation.animationName || animation.id || 'Web Animation', duration: timing && timing.duration, iterations: timing && String(timing.iterations), easing: timing && timing.easing };
      });
      return { title: document.title || 'HTML page', url: location.href, animations,
        totalHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, innerHeight),
        height: fullPage ? Math.min(maxHeight, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, innerHeight)) : innerHeight };
    }, { maxHeight: LIMITS.height, fullPage: opts.fullPage });
    if (meta.totalHeight > LIMITS.height && opts.fullPage) warnings.push(`Page cropped at ${LIMITS.height}px; capture sections separately for longer pages.`);
    if (!meta.animations.length && opts.samples > 1) warnings.push('No CSS/Web Animations detected. Timeline states may be identical; JavaScript/canvas motion is not deterministically replayed.');
    const sourceKey = crypto.createHash('sha256').update(opts.url || opts.html).digest('hex').slice(0, 12);
    const prefix = `${sourceKey}-${opts.width}`;
    const screens = [], images = {}, motion = [];
    const states = Array.from({ length: opts.samples }, (_, i) => ({ time: opts.samples === 1 ? null : Math.round(i * opts.durationMs / (opts.samples - 1)), label: opts.samples === 1 ? 'Page' : `Motion ${i + 1}` }));
    if (opts.hover) states.push({ hover: true, label: 'Hover' });
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      onProgress(`Capturing ${state.label} (${i + 1}/${states.length})…`);
      if (state.hover) {
        const target = page.locator(opts.hover).first();
        await target.hover({ timeout: 5000 });
        await page.waitForTimeout(Math.min(opts.durationMs, 2000));
        await page.evaluate(() => document.getAnimations().forEach(animation => animation.pause()));
      } else if (state.time !== null) {
        await page.evaluate(time => window.__h2fAnimations.forEach(animation => { try { animation.currentTime = time; } catch {} }), state.time);
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const assets = await collectAssets(page, meta.height, opts.width, warnings);
      const result = await page.evaluate(({ assets, width, height, maxNodes }) => window.PrototypeExtract.snapshot(window, { assets, width, height, maxNodes }), { assets, width: opts.width, height: meta.height, maxNodes: LIMITS.nodes });
      const imagePrefix = `s${i}-`;
      function remap(node) {
        for (const fill of node.fills || []) if (fill.imageId) fill.imageId = imagePrefix + fill.imageId;
        for (const child of node.children || []) remap(child);
      }
      remap(result.tree);
      for (const [id, bytes] of Object.entries(result.images)) images[imagePrefix + id] = bytes;
      const id = `${prefix}-${i}`;
      screens.push({ id, name: `${meta.title} · ${opts.width}px · ${state.label}`, tree: result.tree, state });
      warnings.push(...result.warnings);
      if (!state.hover && i > 0) motion.push({ from: screens[i - 1].id, to: id, durationMs: state.time - states[i - 1].time, trigger: 'AFTER_TIMEOUT' });
      if (state.hover) {
        const key = await page.locator(opts.hover).first().getAttribute('data-h2f-key');
        motion.push({ from: screens[0].id, to: id, durationMs: 300, trigger: 'ON_HOVER', sourceKey: key });
      }
      // Reference is a separate raster frame. Editable layers are never replaced silently.
      const reference = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: opts.width, height: meta.height }, captureBeyondViewport: true, animations: 'allow', timeout: 20000 });
      const refId = `reference-${i}`;
      images[refId] = reference.toString('base64');
      screens.at(-1).reference = { imageId: refId, width: opts.width, height: meta.height };
      if (Buffer.byteLength(JSON.stringify(images)) > LIMITS.bytes) throw new Error('Capture exceeds 60 MB. Reduce height or motion samples.');
    }
    if (opts.loop && opts.samples > 1) motion.push({ from: screens[opts.samples - 1].id, to: screens[0].id, durationMs: Math.round(opts.durationMs / (opts.samples - 1)), trigger: 'AFTER_TIMEOUT' });
    return { schemaVersion: 1, generator: 'HTML & Websites → Figma 6', capturedAt: new Date().toISOString(),
      source: { title: meta.title, url: opts.url || null, width: opts.width, height: meta.height },
      screens, images, tokens: [], motion, animations: meta.animations,
      warnings: [...new Set(warnings)], opts: { components: false, tokens: false, references: true, resync: false, motion: true } };
  } finally { await context.close(); }
}
async function collectAssets(page, height, width, warnings) {
  const candidates = await page.evaluate(() => {
    const results = [];
    function visit(el) {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < .5 || r.height < .5) {
        if (cs.display === 'contents') for (const child of el.children) visit(child);
        return;
      }
      let transform = false;
      if (cs.transform !== 'none') {
        const m = new DOMMatrix(cs.transform);
        transform = !m.is2D || Math.abs(m.b) > .0001 || Math.abs(m.c) > .0001 || Math.abs(m.a - 1) > .0001 || Math.abs(m.d - 1) > .0001;
      }
      const raster = ['IMG', 'VIDEO', 'CANVAS', 'IFRAME'].includes(el.tagName) || transform || el.shadowRoot || cs.filter !== 'none' || cs.backdropFilter !== 'none' || cs.clipPath !== 'none' || cs.maskImage !== 'none' || cs.mixBlendMode !== 'normal' || /radial-gradient|conic-gradient|url\(/.test(cs.backgroundImage);
      if (raster && el !== document.body && el !== document.documentElement) {
        results.push({ key: el.getAttribute('data-h2f-key'), tag: el.tagName, x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, reason: ['IMG', 'VIDEO', 'CANVAS'].includes(el.tagName) ? 'media' : 'complex CSS, embedded content or transform' });
        return;
      }
      for (const child of el.children) visit(child);
    }
    visit(document.body);
    return results;
  });
  const assets = {};
  if (candidates.length > LIMITS.assets) warnings.push(`Only ${LIMITS.assets} media regions captured; use a smaller page section.`);
  for (const item of candidates.slice(0, LIMITS.assets)) {
    const x = Math.max(0, item.x), y = Math.max(0, item.y);
    const w = Math.min(width, item.x + item.width) - x, h = Math.min(height, item.y + item.height) - y;
    if (w < 1 || h < 1) continue;
    try {
      const png = await page.screenshot({ type: 'png', clip: { x, y, width: w, height: h }, captureBeyondViewport: true, animations: 'allow', timeout: 10000 });
      assets[item.key] = { data: `data:image/png;base64,${png.toString('base64')}`, x, y, w, h };
      if (item.reason !== 'media') warnings.push(`Layer ${item.key} (${item.tag.toLowerCase()}) preserved as pixels: ${item.reason}.`);
    } catch (error) { warnings.push(`Could not capture layer ${item.key}: ${error.message.split('\n')[0]}`); }
  }
  return assets;
}
module.exports = { capture, captureInBrowser, launch, validate, LIMITS };
