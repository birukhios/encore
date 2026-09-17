/* ══════════════════════════════════════════════════════════════════════════
   HTML Screens → Figma  ·  plugin sandbox
   Receives a layout tree from the UI iframe and builds real Figma layers.
   ══════════════════════════════════════════════════════════════════════════ */

figma.showUI(__html__, { width: 460, height: 640, themeColors: true });

const COLLECTION = 'Prototype tokens';
const COMPPAGE = 'Prototype components';
let VARS = {};          // hexKey -> Variable  (for binding fills)
let VARBYNAME = {};     // token name -> Variable
let IMAGES = {};        // imageId -> figma Image hash
let FONTFALLBACK = [];  // [{wanted, used}]
let CHUNKS = [];
let ORIGIN = { x: 0, y: 0 };
let COMPS = {};         // signature -> { comp, count, name }
let MAKING_MASTER = false;
let GROUP = '';
let INSTANCES = 0;
let BUILDING = false;
let CHUNK_BYTES = 0;
let BUILD_WARNINGS = [];

/* ─────────────── helpers ─────────────── */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64ToBytes(b64) {
  if (typeof figma.base64Decode === 'function') return figma.base64Decode(b64);
  b64 = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((b64.length * 3) >> 2);
  let p = 0, i = 0;
  while (i < b64.length) {
    const a = B64.indexOf(b64[i++]), b = B64.indexOf(b64[i++]);
    const c = B64.indexOf(b64[i++]), d = B64.indexOf(b64[i++]);
    out[p++] = (a << 2) | (b >> 4);
    if (c >= 0) out[p++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[p++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, p);
}

const hexOf = c =>
  ((Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255))
    .toString(16).padStart(6, '0');

function solid(color, opacity) {
  const p = { type: 'SOLID', color: { r: color.r, g: color.g, b: color.b } };
  if (opacity !== undefined && opacity < 1) p.opacity = opacity;
  return p;
}

/* bind a paint to a token variable when the colour is an exact token match */
function bindIfToken(paint) {
  if (paint.type !== 'SOLID') return paint;
  const v = VARS[hexOf(paint.color)];
  if (!v) return paint;
  try { return figma.variables.setBoundVariableForPaint(paint, 'color', v); }
  catch (e) { return paint; }
}

/* ─────────────── fonts ─────────────── */

const WEIGHT_STYLE = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black'
};
const FONTMAP = {};   // "family|style" -> {family, style} actually usable

async function tryFont(family, style) {
  try { await figma.loadFontAsync({ family, style }); return { family, style }; }
  catch (e) { return null; }
}

/* Figma writes these as "Semi Bold"; CSS-ish names arrive as "SemiBold".
   Try both spellings, then neighbouring weights, before giving up on Inter. */
function spaced(s) { return s.replace(/([a-z])([A-Z])/g, '$1 $2'); }

function styleLadder(weight, italic) {
  const target = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  const order = [100, 200, 300, 400, 500, 600, 700, 800, 900]
    .slice().sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
  const out = [];
  const add = s => { if (s && out.indexOf(s) < 0) out.push(s); };
  order.forEach((w, i) => {
    const base = WEIGHT_STYLE[w];
    const sp = spaced(base);
    if (italic) {
      if (base === 'Regular') add('Italic');
      else { add(sp + ' Italic'); add(base + ' Italic'); }
    }
    add(sp); add(base);
    if (i === 0 && italic) add('Italic');
  });
  return out;
}

async function resolveFont(family, weight, italic) {
  const key = family + '|' + weight + '|' + (italic ? 'i' : '');
  if (FONTMAP[key]) return FONTMAP[key];
  const styles = styleLadder(weight, italic);
  const wanted = family + ' ' + styles[0];
  for (const fam of [family, 'Inter']) {
    for (const st of styles) {
      const got = await tryFont(fam, st);
      if (got) {
        if (fam !== family || st !== styles[0]) FONTFALLBACK.push({ wanted: wanted, used: got.family + ' ' + got.style });
        FONTMAP[key] = got;
        return got;
      }
    }
  }
  const last = (await tryFont('Inter', 'Regular')) || { family: 'Inter', style: 'Regular' };
  FONTFALLBACK.push({ wanted: wanted, used: 'Inter Regular' });
  FONTMAP[key] = last;
  return last;
}

async function preloadFonts(tree) {
  const seen = {};
  (function walk(n) {
    if (n.type === 'TEXT') {
      seen[n.fontFamily + '|' + n.fontWeight + '|' + (n.italic ? 'i' : '')] = n;
      (n.runs || []).forEach(r => {
        seen[r.fontFamily + '|' + r.fontWeight + '|' + (r.italic ? 'i' : '')] =
          { fontFamily: r.fontFamily, fontWeight: r.fontWeight, italic: r.italic };
      });
    }
    (n.children || []).forEach(walk);
  })(tree);
  for (const k in seen) {
    const n = seen[k];
    await resolveFont(n.fontFamily, n.fontWeight, n.italic);
  }
}

/* ─────────────── variables from the CSS tokens ─────────────── */

async function buildTokens(tokens, mode) {
  VARS = {}; VARBYNAME = {};
  if (!tokens || !tokens.colors || !tokens.colors.length) return { made: 0 };
  mode = mode || 'auto';

  let coll = figma.variables
    .getLocalVariableCollectionsAsync
    ? (await figma.variables.getLocalVariableCollectionsAsync()).find(c => c.name === COLLECTION)
    : null;
  if (!coll) coll = figma.variables.createVariableCollection(COLLECTION);

  /* Starter and Professional files cap a collection's modes — Starter at one.
     Ask for the second mode, and carry on with a single one if Figma says no. */
  const darkFirst = mode === 'dark';
  const baseName = darkFirst ? 'Dark' : 'Light';
  const otherName = darkFirst ? 'Light' : 'Dark';

  let baseId = coll.modes[0].modeId;
  try { coll.renameMode(baseId, baseName); } catch (e) {}

  let otherId = (coll.modes.find(m => m.name === otherName) || {}).modeId;
  let limited = false;
  if (!otherId && mode === 'auto' && tokens.hasDark) {
    try { otherId = coll.addMode(otherName); }
    catch (e) { limited = true; }
  }
  const lightId = darkFirst ? otherId : baseId;
  const darkId = darkFirst ? baseId : otherId;

  const existing = figma.variables.getLocalVariablesAsync
    ? await figma.variables.getLocalVariablesAsync('COLOR')
    : [];
  const byName = {};
  existing.forEach(v => { if (v.variableCollectionId === coll.id) byName[v.name] = v; });

  let made = 0;
  for (const t of tokens.colors) {
    const name = t.name.replace(/^--/, '').replace(/-/g, '/');
    let v = byName[name];
    if (!v) { v = figma.variables.createVariable(name, coll, 'COLOR'); made++; }
    const baseVal = darkFirst ? (t.dark || t.light) : t.light;
    v.setValueForMode(baseId, baseVal);
    const otherVal = darkFirst ? t.light : t.dark;
    if (otherId && otherVal) v.setValueForMode(otherId, otherVal);
    VARBYNAME[t.name] = v;
    const key = hexOf(t.light);
    if (!VARS[key]) VARS[key] = v;      // first token wins for a given hex
  }
  return {
    made: made,
    total: tokens.colors.length,
    modes: coll.modes.map(m => m.name),
    limited: limited
  };
}

/* ─────────────── repeated elements become components ───────────────
   Two things in a prototype are "the same element" when they have the same
   shape: same box, same fills and strokes, same children in the same places,
   same type at the same size — everything except the words inside. That is
   what this signature captures, so a nav row with different wording still
   matches, and an instance only has to override its text.                */

function sigOf(n) {
  if (n.__sig) return n.__sig;
  let s;
  if (n.type === 'TEXT') {
    s = 'T/' + n.fontFamily + '/' + n.fontWeight + '/' + Math.round(n.fontSize) +
        '/' + (n.color ? hexOf(n.color) : '') + '/' + (n.align || '') +
        '/' + (n.lines || 1) + '/' + Math.round(n.h);
  } else if (n.type === 'SVG') {
    s = 'S/' + Math.round(n.w) + 'x' + Math.round(n.h) + '/' + (n.svg ? n.svg.length : 0);
  } else {
    const f = (n.fills || []).map(x =>
      x.type === 'SOLID' ? hexOf(x.color) : x.type + (x.imageId || '')).join(',');
    const st = (n.strokes || []).map(x => (x.color ? hexOf(x.color) : '')).join(',');
    const kids = (n.children || []).map(c =>
      Math.round(c.x) + ',' + Math.round(c.y) + '=' + sigOf(c)).join('|');
    s = 'F/' + Math.round(n.w) + 'x' + Math.round(n.h) + '/' + f + '/' + st + '/' +
        (n.strokeWeight || 0) + '/' + (n.radius || []).join('.') + '/' +
        (n.clip ? 'c' : '') + '[' + kids + ']';
  }
  n.__sig = s;
  return s;
}

function sizeOf(n) {
  if (n.__size) return n.__size;
  let k = 1;
  (n.children || []).forEach(c => { k += sizeOf(c); });
  n.__size = k;
  return k;
}

function hasInk(n) {
  if (n.type === 'TEXT' || n.type === 'SVG') return true;
  return (n.children || []).some(hasInk);
}

/* A component is worth making when a designer would recognise it as a thing:
   a nav row, a card, a button, a badge. A bare <td> or an unclassed <div> is
   scaffolding — repeated, but not a component. */
const NOT_A_COMPONENT = /^(td|th|span|b|i|em|strong|p|h1|h2|h3|h4|h5|h6|label|small|br|hr|li)(\.|#|$)/;

function componentish(n) {
  const raw = String(n.cls || n.name || '');
  if (NOT_A_COMPONENT.test(raw)) return false;
  return raw.indexOf('.') > -1;          // it has a class, so the page named it
}

function prettyName(n) {
  const raw = String(n.cls || n.name || 'element');
  const cls = raw.split('.').slice(1).filter(c => !/^(row|col|flex|grid|wrap|inner)$/.test(c));
  const pick = (cls[cls.length - 1] || cls[0] || raw.split(/[.#]/)[0] || 'element').trim();
  return pick.charAt(0).toUpperCase() + pick.slice(1);
}

function planComponents(screens, limit) {
  const bag = {};
  screens.forEach(s => {
    (function scan(n, depth) {
      if (depth > 0 && n.type !== 'TEXT' && n.type !== 'SVG') {
        const k = sizeOf(n);
        if (k >= 3 && k <= 60 && n.w >= 24 && n.h >= 14 && hasInk(n) && componentish(n)) {
          const sig = sigOf(n);
          (bag[sig] = bag[sig] || { rep: n, count: 0 }).count++;
        }
      }
      (n.children || []).forEach(c => scan(c, depth + 1));
    })(s.tree, 0);
  });

  /* keep the ones that actually repeat, biggest payoff first, and never keep a
     component that lives inside another kept component — nesting masters that
     way produces instances nobody can edit sensibly */
  const keep = Object.keys(bag)
    .filter(k => bag[k].count >= 3)
    .sort((a, b) => (bag[b].count * sizeOf(bag[b].rep)) - (bag[a].count * sizeOf(bag[a].rep)))
    .slice(0, limit || 60);

  const chosen = {};
  const inner = {};
  keep.forEach(k => {
    if (inner[k]) return;
    chosen[k] = bag[k];
    (function mark(n) {
      (n.children || []).forEach(c => { inner[sigOf(c)] = 1; mark(c); });
    })(bag[k].rep);
  });
  Object.keys(chosen).forEach(k => { if (inner[k]) delete chosen[k]; });

  const names = {};
  Object.keys(chosen).forEach(k => {
    let nm = prettyName(chosen[k].rep);
    if (names[nm]) { names[nm]++; nm = nm + ' ' + names[nm]; } else names[nm] = 1;
    chosen[k].name = (GROUP ? GROUP + '/' : '') + nm;   // slashes nest them in Assets
  });
  return chosen;
}

async function buildComponents(plan) {
  const keys = Object.keys(plan);
  if (!keys.length) return { made: 0, reused: 0 };

  await figma.loadAllPagesAsync();
  let page = figma.root.children.filter(p => p.name === COMPPAGE)[0];
  if (!page) { page = figma.createPage(); page.name = COMPPAGE; }

  const known = {};
  page.children.forEach(ch => {
    const sig = ch.getPluginData && ch.getPluginData('sig');
    if (sig && ch.type === 'COMPONENT') known[sig] = ch;
  });

  let made = 0, reused = 0, x = 0, y = 0, rowH = 0;
  page.children.forEach(ch => { y = Math.max(y, ch.y + ch.height + 40); });

  for (const k of keys) {
    const spec = plan[k];
    if (known[k]) { COMPS[k] = { comp: known[k], count: spec.count, name: spec.name }; reused++; continue; }

    MAKING_MASTER = true;
    const comp = figma.createComponent();
    comp.name = spec.name;
    comp.resize(Math.max(1, spec.rep.w), Math.max(1, spec.rep.h));
    applyBox(comp, Object.assign({}, spec.rep, { x: 0, y: 0 }));
    comp.name = spec.name;
    for (const c of (spec.rep.children || [])) await buildNode(c, comp);
    MAKING_MASTER = false;

    comp.setPluginData('sig', k);
    comp.x = x; comp.y = y;
    page.appendChild(comp);
    x += comp.width + 48;
    rowH = Math.max(rowH, comp.height);
    if (x > 2400) { x = 0; y += rowH + 48; rowH = 0; }

    COMPS[k] = { comp: comp, count: spec.count, name: spec.name };
    made++;
  }
  return { made, reused, page: page.name };
}

/* an instance carries the master's words — put this occurrence's own back in */
async function overrideText(src, node) {
  if (src.type === 'TEXT') {
    if (node.type === 'TEXT' && node.characters !== src.chars) {
      try {
        if (node.fontName !== figma.mixed) await figma.loadFontAsync(node.fontName);
        node.characters = src.chars;
      } catch (e) {}
    }
    return;
  }
  const kids = node.children || [];
  const srcKids = src.children || [];
  for (let i = 0; i < srcKids.length; i++) {
    if (kids[i]) await overrideText(srcKids[i], kids[i]);
  }
}

/* ─────────────── node building ─────────────── */

function applyBox(node, n) {
  node.name = n.name || 'Frame';
  if (n.sourceKey != null) node.setPluginData('sourceKey', String(n.sourceKey));
  node.x = n.x; node.y = n.y;
  try { node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h)); } catch (e) {}

  if (n.fills && n.fills.length) {
    const fills = n.fills.map(f => {
      if (f.type === 'SOLID') return bindIfToken(solid(f.color, f.opacity));
      if (f.type === 'IMAGE' && IMAGES[f.imageId]) {
        return { type: 'IMAGE', scaleMode: f.scaleMode || 'FILL', imageHash: IMAGES[f.imageId] };
      }
      if (f.type === 'GRADIENT_LINEAR') {
        return {
          type: 'GRADIENT_LINEAR',
          gradientTransform: f.transform,
          gradientStops: f.stops.map(s => ({
            position: s.position,
            color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a === undefined ? 1 : s.color.a }
          }))
        };
      }
      return null;
    }).filter(Boolean);
    node.fills = fills;
  } else if (node.type === 'FRAME') {
    node.fills = [];
  }

  if (n.strokes && n.strokes.length) {
    node.strokes = n.strokes.map(s => bindIfToken(solid(s.color, s.opacity)));
    node.strokeWeight = n.strokeWeight || 1;
    node.strokeAlign = 'INSIDE';
  }

  if (n.radius) {
    const [tl, tr, br, bl] = n.radius;
    if (tl === tr && tr === br && br === bl) { try { node.cornerRadius = tl; } catch (e) {} }
    else {
      try {
        node.topLeftRadius = tl; node.topRightRadius = tr;
        node.bottomRightRadius = br; node.bottomLeftRadius = bl;
      } catch (e) {}
    }
  }

  if (n.effects && n.effects.length) {
    try {
      node.effects = n.effects.map(e => ({
        type: e.type,
        color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a === undefined ? 1 : e.color.a },
        offset: { x: e.dx, y: e.dy },
        radius: e.blur,
        spread: e.spread || 0,
        visible: true,
        blendMode: 'NORMAL'
      }));
    } catch (e) {}
  }

  if (n.opacity !== undefined && n.opacity < 1) node.opacity = n.opacity;
  if (n.clip && node.type === 'FRAME') node.clipsContent = true;
  else if (node.type === 'FRAME') node.clipsContent = false;
}

async function buildNode(n, parent) {
  let node = null;

  if (!MAKING_MASTER && n.__sig && COMPS[n.__sig]) {
    const spec = COMPS[n.__sig];
    try {
      const inst = spec.comp.createInstance();
      inst.x = n.x; inst.y = n.y;
      if (n.opacity !== undefined && n.opacity < 1) inst.opacity = n.opacity;
      parent.appendChild(inst);
      await overrideText(n, inst);
      INSTANCES++;
      return inst;
    } catch (e) { /* fall through and draw it plainly */ }
  }

  if (n.type === 'TEXT') {
    node = figma.createText();
    const f = await resolveFont(n.fontFamily, n.fontWeight, n.italic);
    node.fontName = f;
    node.characters = n.chars;
    node.fontSize = Math.max(1, n.fontSize);
    if (n.lineHeight) node.lineHeight = { value: n.lineHeight, unit: 'PIXELS' };
    if (n.letterSpacing) node.letterSpacing = { value: n.letterSpacing, unit: 'PIXELS' };
    if (n.align) { try { node.textAlignHorizontal = n.align; } catch (e) {} }
    if (n.decoration) { try { node.textDecoration = n.decoration; } catch (e) {} }
    if (n.transform) { try { node.textCase = n.transform; } catch (e) {} }
    /* Inter is not the font the browser measured with, so the same box would
       re-wrap "Dashboard" into "Dashbo / ard". One-line text is left free to
       size itself; wrapped text keeps its width and grows downward. */
    node.name = n.name || n.chars.slice(0, 28);
    if (!n.lines || n.lines <= 1) {
      node.textAutoResize = 'WIDTH_AND_HEIGHT';
    } else {
      node.textAutoResize = 'HEIGHT';
      try { node.resize(Math.max(1, n.w + 1), Math.max(1, n.h)); } catch (e) {}
    }
    try { node.textAlignVertical = 'TOP'; } catch (e) {}
    node.x = n.x; node.y = n.y;
    node.fills = [bindIfToken(solid(n.color, n.colorOpacity))];

    /* the bold or coloured stretches inside a merged paragraph */
    for (const r of (n.runs || [])) {
      const a = Math.max(0, Math.min(n.chars.length, r.start));
      const b = Math.max(a, Math.min(n.chars.length, r.end));
      if (b <= a) continue;
      try {
        if (r.fontWeight !== n.fontWeight || r.italic !== n.italic || r.fontFamily !== n.fontFamily) {
          node.setRangeFontName(a, b, await resolveFont(r.fontFamily, r.fontWeight, r.italic));
        }
        if (r.color) node.setRangeFills(a, b, [bindIfToken(solid(r.color, r.colorOpacity))]);
      } catch (e) {}
    }

    if (n.opacity !== undefined && n.opacity < 1) node.opacity = n.opacity;
    parent.appendChild(node);
    return node;
  }

  if (n.type === 'SVG') {
    try {
      node = figma.createNodeFromSvg(n.svg);
      node.name = n.name || 'Icon';
      /* Resizing a frame does not scale its contents — rescale does. Only fall
         back to a plain resize when the import already came in square-on. */
      try {
        const want = Math.max(0.01, n.w), got = node.width || want;
        const k = want / got;
        if (isFinite(k) && k > 0 && Math.abs(k - 1) > 0.01) node.rescale(k);
        if (Math.abs(node.width - want) > 0.5 || Math.abs(node.height - Math.max(0.01, n.h)) > 0.5) {
          node.resize(want, Math.max(0.01, n.h));
        }
      } catch (e) {
        try { node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h)); } catch (e2) {}
      }
      node.x = n.x; node.y = n.y;
      if (n.opacity !== undefined && n.opacity < 1) node.opacity = n.opacity;
      parent.appendChild(node);
      if (n.sourceKey != null) node.setPluginData('sourceKey', String(n.sourceKey));
      return node;
    } catch (e) {
      node = figma.createFrame();     // fall through to a plain box
    }
  }

  if (!node) node = figma.createFrame();
  applyBox(node, n);
  parent.appendChild(node);

  for (const c of (n.children || [])) await buildNode(c, node);
  return node;
}

/* ─────────────── screen frames ─────────────── */

function findExistingScreen(id) {
  const stack = [figma.currentPage];
  while (stack.length) {
    const p = stack.pop();
    for (const ch of p.children) {
      if (ch.getPluginData && ch.getPluginData('screenId') === id) return ch;
      if (ch.type === 'SECTION' || ch.type === 'GROUP') stack.push(ch);
    }
  }
  return null;
}

async function importScreen(screen, opts, index) {
  const existing = opts.resync ? findExistingScreen(screen.id) : null;
  const frame = figma.createFrame();
  frame.name = screen.name;
  frame.resize(Math.max(1, screen.tree.w), Math.max(1, screen.tree.h));
  frame.clipsContent = true;
  applyBox(frame, screen.tree);
  frame.name = screen.name;
  frame.clipsContent = true;
  frame.setPluginData('screenId', screen.id);
  frame.setPluginData('importedAt', String(Date.now()));

  for (const c of (screen.tree.children || [])) await buildNode(c, frame);

  if (existing) {
    frame.x = existing.x; frame.y = existing.y;
    const parent = existing.parent;
    parent.insertChild(parent.children.indexOf(existing), frame);
    existing.remove();
  } else {
    const gap = 80;
    if (index === 0) { ORIGIN.x = Math.round(figma.viewport.center.x - screen.tree.w / 2); ORIGIN.y = Math.round(figma.viewport.center.y - screen.tree.h / 2); }
    frame.x = ORIGIN.x + index * (screen.tree.w + gap);
    frame.y = ORIGIN.y;
    figma.currentPage.appendChild(frame);
  }
  return frame;
}


function validatePayload(payload) {
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.screens) || !payload.screens.length || payload.screens.length > 12 || !payload.opts) throw new Error('Unsupported capture. Use the v6 capture companion.');
  const ids = new Set(); let count = 0;
  function check(n, depth) {
    if (++count > 120000 || depth > 130) throw new Error('Too many layers in capture.');
    if (!n || !['FRAME','TEXT','SVG'].includes(n.type)) throw new Error('Invalid layer type.');
    for (const key of ['x','y','w','h']) if (!Number.isFinite(n[key]) || Math.abs(n[key]) > 1000000 || ((key === 'w' || key === 'h') && n[key] <= 0)) throw new Error('Invalid layer geometry.');
    if (n.type === 'TEXT' && (typeof n.chars !== 'string' || !Number.isFinite(n.fontSize))) throw new Error('Invalid text layer.');
    if (n.children && !Array.isArray(n.children)) throw new Error('Invalid children.');
    for (const child of n.children || []) check(child, depth + 1);
  }
  for (const screen of payload.screens) {
    if (typeof screen.id !== 'string' || ids.has(screen.id)) throw new Error('Duplicate or missing screen ID.');
    ids.add(screen.id); check(screen.tree, 0);
  }
}

/* ─────────────── message pump ─────────────── */

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'reset') { if (!BUILDING) { CHUNKS = []; CHUNK_BYTES = 0; } return; }
    if (msg.type === 'chunk') {
      if (BUILDING) throw new Error('An import is already running.');
      if (typeof msg.data !== 'string' || (CHUNK_BYTES += msg.data.length) > 80 * 1024 * 1024) { CHUNKS = []; CHUNK_BYTES = 0; throw new Error('Capture is too large.'); }
      CHUNKS.push(msg.data); return;
    }

    if (msg.type === 'build') {
      if (BUILDING) return;
      BUILDING = true; BUILD_WARNINGS = []; FONTFALLBACK = [];
      const raw = CHUNKS.join('');
      if (!raw) throw new Error('nothing arrived from the panel — try the import again');
      const payload = JSON.parse(raw);
      CHUNKS = [];
      const { screens, tokens, images, opts } = payload;
      validatePayload(payload);
      CHUNK_BYTES = 0;
      IMAGES = {};
      for (const id in (images || {})) {
        try { IMAGES[id] = figma.createImage(b64ToBytes(images[id])).hash; } catch (e) { BUILD_WARNINGS.push('Could not decode image ' + id); }
      }

      figma.ui.postMessage({ type: 'progress', text: 'Creating variables…' });
      const tk = await buildTokens(opts.tokens ? tokens : null, opts.mode);

      COMPS = {};
      let comp = { made: 0, reused: 0 };
      if (opts.components !== false) {
        figma.ui.postMessage({ type: 'progress', text: 'Finding elements that repeat…' });
        GROUP = (opts.group || '').replace(/[/\\]/g, ' ').trim();
        const plan = planComponents(screens, 60);
        const nPlan = Object.keys(plan).length;
        if (nPlan) {
          figma.ui.postMessage({ type: 'progress', text: 'Building ' + nPlan + ' components…' });
          for (const k of Object.keys(plan)) await preloadFonts(plan[k].rep);
          comp = await buildComponents(plan);
        }
      }

      INSTANCES = 0;
      const made = [];
      for (let i = 0; i < screens.length; i++) {
        const s = screens[i];
        figma.ui.postMessage({ type: 'progress', text: 'Building ' + s.name + ' (' + (i + 1) + '/' + screens.length + ')' });
        await preloadFonts(s.tree);
        made.push(await importScreen(s, opts, i));
      }

      let connections = 0;
      if (opts.motion !== false) {
        const framesById = {};
        screens.forEach((screen, i) => { framesById[screen.id] = made[i]; });
        for (const link of (payload.motion || [])) {
          const from = framesById[link.from], to = framesById[link.to];
          if (!from || !to) continue;
          let target = from;
          if (link.sourceKey != null) target = from.findOne(n => n.getPluginData('sourceKey') === String(link.sourceKey));
          if (!target || !target.setReactionsAsync) { BUILD_WARNINGS.push('Hover target could not be connected.'); continue; }
          const trigger = link.trigger === 'ON_HOVER' ? { type: 'ON_HOVER' } : { type: 'AFTER_TIMEOUT', timeout: 1 };
          try {
            await target.setReactionsAsync([...(target.reactions || []), { trigger, actions: [{ type:'NODE', destinationId:to.id, navigation:'NAVIGATE', transition:{type:'SMART_ANIMATE', easing:{type:'LINEAR'}, duration:Math.max(.01, Math.min(10, Number(link.durationMs) / 1000 || .3))} }] }]);
            connections++;
          } catch (e) { BUILD_WARNINGS.push('Motion connection: ' + e.message); }
        }
      }
      if (opts.references !== false) {
        for (let i = 0; i < screens.length; i++) {
          const ref = screens[i].reference;
          if (!ref || !IMAGES[ref.imageId]) continue;
          const frame = figma.createFrame();
          frame.name = screens[i].name + ' · Browser reference (image)';
          frame.resize(ref.width, ref.height);
          frame.x = made[i].x; frame.y = made[i].y + made[i].height + 100;
          frame.fills = [{type:'IMAGE', imageHash:IMAGES[ref.imageId], scaleMode:'FILL'}];
          frame.locked = true;
        }
      }
      if (made.length) figma.viewport.scrollAndZoomIntoView(made);
      figma.currentPage.selection = made;

      const subs = {};
      FONTFALLBACK.forEach(f => { subs[f.wanted + ' → ' + f.used] = 1; });
      figma.ui.postMessage({
        type: 'done',
        connections, warnings: BUILD_WARNINGS,
        screens: made.length,
        variables: tk.made || 0,
        tokensTotal: tk.total || 0,
        modes: tk.modes || [],
        modesLimited: !!tk.limited,
        components: comp.made || 0,
        componentsReused: comp.reused || 0,
        instances: INSTANCES,
        substitutions: Object.keys(subs)
      });
      BUILDING = false;
      figma.notify(made.length + (made.length === 1 ? ' screen imported' : ' screens imported'));
      return;
    }

    if (msg.type === 'listExisting') {
      await figma.loadAllPagesAsync();
      const found = [];
      for (const page of figma.root.children) {
        for (const ch of page.children) {
          const id = ch.getPluginData && ch.getPluginData('screenId');
          if (id) found.push({ id, name: ch.name, page: page.name });
        }
      }
      figma.ui.postMessage({ type: 'existing', found });
      return;
    }

    if (msg.type === 'close') figma.closePlugin();
  } catch (err) {
    BUILDING = false; CHUNKS = []; CHUNK_BYTES = 0;
    figma.ui.postMessage({ type: 'error', message: String(err && err.message || err) });
    figma.notify('Import failed: ' + String(err && err.message || err), { error: true });
  }
};
