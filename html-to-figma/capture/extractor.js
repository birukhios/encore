/* ══════════════════════════════════════════════════════════════════════════
   DOM → layout tree.  Runs in the plugin's UI iframe (a real browser),
   reads computed styles out of the loaded prototype and emits a tree the
   Figma sandbox can turn into layers.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root) {

const SKIP_TAGS = { SCRIPT:1, STYLE:1, LINK:1, META:1, TITLE:1, HEAD:1, NOSCRIPT:1, TEMPLATE:1, BR:1 };
let IMAGES = {}, imgSeq = 0, NODE_BUDGET = 6000, used = 0, WARN = [];

/* ── colour ───────────────────────────────────────────────────────────── */
function col(str) {
  if (!str || str === 'none' || str === 'transparent') return null;
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
  const a = p.length > 3 ? p[3] : 1;
  if (a === 0) return null;
  return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: a };
}
const hex6 = c => ((Math.round(c.r*255)<<16)|(Math.round(c.g*255)<<8)|Math.round(c.b*255)).toString(16).padStart(6,'0');

/* ── shadows ──────────────────────────────────────────────────────────── */
function shadows(str) {
  if (!str || str === 'none') return [];
  const out = [];
  // split on commas that are not inside rgb()/rgba()
  const parts = str.split(/,(?![^(]*\))/);
  for (const raw of parts) {
    const s = raw.trim();
    const inset = /\binset\b/.test(s);
    const c = col(s) || { r:0, g:0, b:0, a:.25 };
    const nums = (s.replace(/rgba?\([^)]+\)/, '').match(/-?\d*\.?\d+px/g) || []).map(parseFloat);
    if (!nums.length) continue;
    out.push({
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: c, dx: nums[0] || 0, dy: nums[1] || 0,
      blur: nums[2] || 0, spread: nums[3] || 0
    });
  }
  return out.slice(0, 4);
}

/* ── linear gradients ─────────────────────────────────────────────────── */
function gradient(bg, w, h) {
  if (!bg || bg.indexOf('linear-gradient') < 0) return null;
  const body = bg.slice(bg.indexOf('linear-gradient(') + 16, bg.lastIndexOf(')'));
  const parts = body.split(/,(?![^(]*\))/).map(s => s.trim());
  let deg = 180;
  if (/^-?\d+(\.\d+)?deg$/.test(parts[0])) { deg = parseFloat(parts.shift()); }
  else if (/^to\s/.test(parts[0])) {
    const dir = parts.shift().replace('to ', '').trim();
    deg = { 'top':0,'right':90,'bottom':180,'left':270,
            'top right':45,'right top':45,'bottom right':135,'right bottom':135,
            'bottom left':225,'left bottom':225,'top left':315,'left top':315 }[dir];
    if (deg === undefined) deg = 180;
  }
  const stops = [];
  parts.forEach((p, i) => {
    const c = col(p); if (!c) return;
    const pm = p.match(/(\d*\.?\d+)%/);
    stops.push({ color: c, position: pm ? parseFloat(pm[1]) / 100 : (i / Math.max(1, parts.length - 1)) });
  });
  if (stops.length < 2) return null;
  const rad = (deg - 90) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    type: 'GRADIENT_LINEAR',
    transform: [[cos, sin, (1 - cos - sin) / 2], [-sin, cos, (1 + sin - cos) / 2]],
    stops: stops
  };
}

/* ── radius / borders ─────────────────────────────────────────────────── */
const px = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function radius(cs, w, h) {
  const lim = Math.min(w, h) / 2;
  const r = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
    .map(v => v.indexOf('%') > -1 ? lim : Math.min(px(v), lim));
  return r.some(v => v > 0) ? r : null;
}

/* ── svg: inline <use> sprites and resolve currentColor ───────────────── */
/* An SVG lifted out of the page loses the page's stylesheet and its CSS
   variables, so fill="var(--p700)" would come out black. Read what the
   browser actually painted and write it onto the copy as plain attributes. */
const PAINT_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-opacity', 'fill-opacity', 'opacity'];
const TEXT_PROPS = ['font-size', 'font-family', 'font-weight', 'text-anchor'];

/* Only write back what the page's CSS actually decided. Writing the initial
   values instead — fill:black, stroke:none — would paint over exactly the
   attributes a sprite icon relies on. */
function bakeOne(win, src, dst, props) {
  let cs, ps;
  try {
    cs = win.getComputedStyle(src);
    ps = src.parentElement ? win.getComputedStyle(src.parentElement) : null;
  } catch (e) { return; }
  for (const p of props) {
    const v = (cs.getPropertyValue(p) || '').trim();
    if (!v || v === 'normal' || v === 'auto') continue;
    const authored = (src.getAttribute(p) || '') + ' ' + (src.getAttribute('style') || '');
    if (authored.indexOf('var(') > -1) { dst.setAttribute(p, v); continue; }  // it needs resolving
    if (src.hasAttribute(p)) continue;                                        // already explicit
    if (ps && (ps.getPropertyValue(p) || '').trim() === v) continue;          // just inherited
    dst.setAttribute(p, v);
  }
}

function bakePaint(win, srcEl, dstEl) {
  const src = [srcEl].concat(Array.prototype.slice.call(srcEl.querySelectorAll('*')));
  const dst = [dstEl].concat(Array.prototype.slice.call(dstEl.querySelectorAll('*')));
  const n = Math.min(src.length, dst.length);
  for (let i = 0; i < n; i++) {
    const tag = (dst[i].tagName || '').toLowerCase();
    if (tag === 'title' || tag === 'desc') continue;
    bakeOne(win, src[i], dst[i], PAINT_PROPS);
    if (tag === 'text' || tag === 'tspan') bakeOne(win, src[i], dst[i], TEXT_PROPS);
  }
}

function inlineSvg(svgEl, doc, color, win, box) {
  const clone = svgEl.cloneNode(true);
  if (win) { try { bakePaint(win, svgEl, clone); } catch (e) {} }
  for (let pass = 0; pass < 6; pass++) {
    const uses = clone.querySelectorAll('use');
    if (!uses.length) break;
    let changed = false;
    uses.forEach(u => {
      const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      if (href.charAt(0) !== '#') { u.remove(); return; }
      const tgt = doc.getElementById(href.slice(1));
      if (!tgt) { u.remove(); return; }
      if (!clone.getAttribute('viewBox') && tgt.getAttribute('viewBox'))
        clone.setAttribute('viewBox', tgt.getAttribute('viewBox'));
      const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
      const x = parseFloat(u.getAttribute('x') || 0), y = parseFloat(u.getAttribute('y') || 0);
      if (x || y) g.setAttribute('transform', 'translate(' + x + ',' + y + ')');
      const uw = parseFloat(u.getAttribute('width')), uh = parseFloat(u.getAttribute('height'));
      const vb = (tgt.getAttribute('viewBox') || '').split(/[\s,]+/).map(parseFloat);
      if (uw && uh && vb.length === 4 && vb[2] && vb[3]) {
        const sx = uw / vb[2], sy = uh / vb[3];
        if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001)
          g.setAttribute('transform', (g.getAttribute('transform') || '') + ' scale(' + sx + ',' + sy + ')');
      }
      /* The symbol's own attributes are what its children inherit — drop them
         and a stroked icon turns into a filled blob. Copy the symbol's first,
         then let the <use>'s own attributes win. */
      const INHERITED = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
        'stroke-dasharray', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'clip-rule',
        'opacity', 'vector-effect', 'color'];
      INHERITED.forEach(a => { if (tgt.hasAttribute(a)) g.setAttribute(a, tgt.getAttribute(a)); });
      if (tgt.getAttribute('style')) g.setAttribute('style', tgt.getAttribute('style'));
      INHERITED.forEach(a => { if (u.hasAttribute(a)) g.setAttribute(a, u.getAttribute(a)); });
      Array.prototype.forEach.call(tgt.childNodes, ch => g.appendChild(ch.cloneNode(true)));
      u.parentNode.replaceChild(g, u);
      changed = true;
    });
    if (!changed) break;
  }
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('viewBox')) {
    const aw = parseFloat(svgEl.getAttribute('width'));
    const ah = parseFloat(svgEl.getAttribute('height'));
    const bw = isFinite(aw) && aw > 0 ? aw : (box && box.width) || 24;
    const bh = isFinite(ah) && ah > 0 ? ah : (box && box.height) || 24;
    clone.setAttribute('viewBox', '0 0 ' + bw + ' ' + bh);
  }
  /* width="100%" or a viewBox-only icon imports at the wrong size and then gets
     cropped, because resizing a frame in Figma does not scale what is inside it */
  if (box && box.width > 0 && box.height > 0) {
    clone.setAttribute('width', String(Math.round(box.width * 100) / 100));
    clone.setAttribute('height', String(Math.round(box.height * 100) / 100));
    clone.setAttribute('preserveAspectRatio', svgEl.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
  }
  let s = new XMLSerializer().serializeToString(clone);
  if (color) s = s.replace(/currentColor/g, '#' + hex6(color));
  /* pull in any document-level defs the markup points at */
  const ids = (s.match(/url\(#([^)]+)\)/g) || []).map(m => m.slice(5, -1));
  if (ids.length) {
    let defs = '';
    ids.forEach(id => {
      if (s.indexOf('id="' + id + '"') > -1) return;
      const d = doc.getElementById(id);
      if (d) defs += new XMLSerializer().serializeToString(d);
    });
    if (defs) s = s.replace(/(<svg[^>]*>)/, '$1<defs>' + defs + '</defs>');
  }
  return s;
}

/* ── images ───────────────────────────────────────────────────────────── */
let IMGSEEN = {};
let SNAPSHOT_ASSETS = null;
let SNAPSHOT_MODE = false;
function stashDataUri(src) {
  if (!src || src.indexOf('data:image') !== 0) return null;
  const comma = src.indexOf(',');
  if (src.slice(0, comma).indexOf('base64') < 0) return null;
  const data = src.slice(comma + 1);
  const key = data.length + ':' + data.slice(0, 64) + data.slice(-32);
  if (IMGSEEN[key]) return IMGSEEN[key];
  const id = 'img' + (++imgSeq);
  IMAGES[id] = data;
  IMGSEEN[key] = id;
  return id;
}

/* ── the walk ─────────────────────────────────────────────────────────── */
function isHidden(cs, el) {
  return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || el.hidden;
}

/* A paragraph like "<b>You become the super admin</b> of the parent account…"
   is one flowing line, not two. Measured separately, the second run reports a
   box that starts at the left margin of its *second* line and lands on top of
   the bold text. So when an element mixes text with inline children, take the
   whole thing as one text layer and record the styled stretches inside it. */

const INLINE_OK = { SPAN: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, A: 1, SMALL: 1, CODE: 1, MARK: 1, ABBR: 1, TIME: 1 };

function isMixedInline(el, win) {
  if (!el.children.length) return false;
  let hasText = false, hasInline = false;
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.nodeValue.trim()) hasText = true;
  }
  if (!hasText) return false;
  for (const c of el.children) {
    if (!INLINE_OK[c.tagName]) return false;
    const d = win.getComputedStyle(c).display;
    if (d !== 'inline') return false;
    if (c.children.length && !isMixedInline(c, win) && c.querySelector('svg,img,br')) return false;
    hasInline = true;
  }
  return hasInline;
}

/* the text, plus where each differently-styled stretch starts and ends */
function flatten(el, win) {
  const segs = [];
  (function go(node, cs) {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        if (n.nodeValue) segs.push({ raw: n.nodeValue, cs: cs });
      } else if (n.nodeType === 1) {
        go(n, win.getComputedStyle(n));
      }
    }
  })(el, win.getComputedStyle(el));

  let out = '';
  const runs = [];
  segs.forEach(sg => {
    const t = sg.raw.replace(/\s+/g, ' ');
    if (!t) return;
    const start = out.length;
    out += t;
    runs.push({ start: start, end: out.length, cs: sg.cs });
  });

  /* trimming the ends has to move the run boundaries with it */
  const lead = out.length - out.replace(/^ +/, '').length;
  out = out.trim();
  runs.forEach(r => {
    r.start = Math.max(0, Math.min(out.length, r.start - lead));
    r.end = Math.max(0, Math.min(out.length, r.end - lead));
  });
  return { text: out, runs: runs.filter(r => r.end > r.start) };
}

function textNodesOf(el) {
  const out = [];
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) out.push(n);
  }
  return out;
}

/* ── naming ────────────────────────────────────────────────────────────
   "div.card" tells a designer nothing. The page already says what each
   element is for — in its aria-label, its heading, the words on the button,
   the class the author chose — so read that and name the layer after it. */

const ROLE_BY_CLASS = {
  'nav-i': 'Nav item', navgrp: 'Nav group', nav: 'Nav', rail: 'Sidebar', sidebar: 'Sidebar',
  topbar: 'Top bar', phead: 'Page header', cardhead: 'Card header', card: 'Card',
  kpi: 'KPI', stat: 'Stat', tile: 'Tile', tiles: 'Tiles', facil: 'Facility card',
  seg: 'Segmented control', btn: 'Button', act: 'Actions', quick: 'Quick actions',
  tag: 'Badge', chip: 'Chip', chips: 'Chips', cnt: 'Count', pill: 'Pill', dot: 'Dot',
  sub: 'Caption', lead: 'Lead', note: 'Note', hint: 'Hint',
  modal: 'Modal', sheet: 'Sheet', veil: 'Overlay', toast: 'Toast', banner: 'Banner',
  list: 'List', row: 'Row', rowflex: 'Row', rowsplit: 'Row', rowbtn: 'Row',
  grid: 'Grid', table: 'Table', tl: 'Timeline', timeline: 'Timeline', vstep: 'Step',
  field: 'Field', input: 'Input', sw: 'Switch', seg1: 'Segment',
  avatar: 'Avatar', av: 'Avatar', mk: 'Logo', lg: 'Logo', wm: 'Logo', brand: 'Brand',
  bar: 'Bar', track: 'Track', meter: 'Meter', head: 'Header', foot: 'Footer',
  body: 'Body', main: 'Main', pane: 'Pane', box: 'Box', auth: 'Sign-in',
  authbox: 'Sign-in form', brandpane: 'Brand panel', formpane: 'Form panel',
  screen: 'Screen', device: 'Device', tabbar: 'Tab bar', statusbar: 'Status bar',
  sbar: 'Status bar', homebar: 'Home indicator', receipt: 'Receipt', num: 'Number',
  nm: 'Name', lockw: 'Logo', mlogo: 'Logo', authswap: 'Switch link', pts: 'Points'
};

const ROLE_BY_TAG = {
  header: 'Header', footer: 'Footer', nav: 'Nav', aside: 'Sidebar', main: 'Main',
  section: 'Section', article: 'Article', form: 'Form', fieldset: 'Field group',
  button: 'Button', a: 'Link', img: 'Image', ul: 'List', ol: 'List', li: 'List item',
  table: 'Table', thead: 'Table head', tbody: 'Table body', tr: 'Table row',
  th: 'Header cell', td: 'Cell', label: 'Label', select: 'Select', textarea: 'Text area',
  input: 'Input', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading',
  h5: 'Heading', h6: 'Heading', p: 'Text', dialog: 'Dialog', figure: 'Figure'
};

function shortText(el) {
  let t = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.nodeValue.trim()) t += ' ' + n.nodeValue;
  }
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) {
    const h = el.querySelector('h1,h2,h3,h4,legend,summary,[class*=title],[class*=name]');
    if (h) t = (h.textContent || '').replace(/\s+/g, ' ').trim();
  }
  if (!t && el.children.length === 0) t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (t.length > 32) t = t.slice(0, 31).trim() + '…';
  return t;
}

function svgName(el) {
  const aria = el.getAttribute('aria-label') || el.getAttribute('title');
  if (aria && aria.trim()) return 'Icon · ' + aria.trim().slice(0, 30);
  const u = el.querySelector('use');
  const href = u && (u.getAttribute('href') || u.getAttribute('xlink:href') || '');
  if (href && href.charAt(0) === '#') {
    return 'Icon · ' + href.slice(1).replace(/^[iu]-/, '').replace(/[-_]/g, ' ');
  }
  const t = el.querySelector('title');
  if (t && t.textContent.trim()) return 'Icon · ' + t.textContent.trim().slice(0, 30);
  return 'Icon';
}

function nameFor(el, tag) {
  const aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
  if (aria && aria.trim()) return aria.trim().slice(0, 40);

  if (tag === 'img') {
    const alt = (el.getAttribute('alt') || '').trim();
    return alt ? 'Image · ' + alt.slice(0, 30) : 'Image';
  }
  if (tag === 'input' || tag === 'textarea') {
    const ph = (el.getAttribute('placeholder') || el.getAttribute('name') || '').trim();
    return (ROLE_BY_TAG[tag] || 'Input') + (ph ? ' · ' + ph.slice(0, 30) : '');
  }

  let role = '';
  const cls = el.className && typeof el.className === 'string' ? el.className.trim().split(/\s+/) : [];
  for (const c of cls) { if (ROLE_BY_CLASS[c]) { role = ROLE_BY_CLASS[c]; break; } }
  if (!role) for (const c of cls) {
    const base = c.split('-')[0];
    if (ROLE_BY_CLASS[base]) { role = ROLE_BY_CLASS[base]; break; }
  }
  if (!role) role = ROLE_BY_TAG[tag] || '';
  if (!role && cls.length) role = cls[0].charAt(0).toUpperCase() + cls[0].slice(1);
  if (!role) role = tag === 'div' || tag === 'span' ? 'Group' : tag;

  const label = shortText(el);
  if (!label) return role;
  if (role === 'Group') return label;          // a plain wrapper is just its words
  if (role === 'Heading' || role === 'Text' || role === 'Label' ||
      role === 'Button' || role === 'Link' || role === 'Cell' || role === 'Header cell') {
    return role + ' · ' + label;
  }
  return label.length <= 24 ? role + ' · ' + label : role;
}

function walk(el, win, ox, oy, depth) {
  if (used >= NODE_BUDGET || depth > 120) { if (!WARN.includes('Layer budget reached; capture a smaller section.')) WARN.push('Layer budget reached; capture a smaller section.'); return null; }
  const doc = win.document;
  if (SKIP_TAGS[el.tagName]) return null;
  const cs = win.getComputedStyle(el);
  if (isHidden(cs, el) && !(SNAPSHOT_MODE && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.hidden)) return null;
  const r = el.getBoundingClientRect();
  if (cs.display === 'contents') {
    return { type: 'FRAME', name: 'Contents · ' + el.getAttribute('data-h2f-key'), x: 0, y: 0, w: 1, h: 1, fills: [], children: Array.from(el.children).map(ch => walk(ch, win, ox, oy, depth + 1)).filter(Boolean) };
  }
  if (r.width < 0.5 || r.height < 0.5) return null;
  const sourceKey = el.getAttribute('data-h2f-key');
  const raster = SNAPSHOT_ASSETS && SNAPSHOT_ASSETS[sourceKey];
  if (raster) {
    used++;
    return { type: 'FRAME', name: nameFor(el, el.tagName.toLowerCase()) + ' · ' + sourceKey, sourceKey,
      x: raster.x - win.scrollX - ox, y: raster.y - win.scrollY - oy, w: raster.w, h: raster.h,
      fills: [{ type: 'IMAGE', imageId: stashDataUri(raster.data), scaleMode: 'FILL' }], children: [], rasterized: true };
  }

  used++;
  const tag = el.tagName.toLowerCase();

  /* canvas → the pixels it already holds */
  if (tag === 'canvas') {
    let id = null;
    try { id = stashDataUri(el.toDataURL('image/png')); } catch (e) { WARN.push('canvas ' + (el.id || '') + ' could not be read'); }
    if (id) {
      return {
        type: 'FRAME', name: 'Chart' + (el.id ? ' · ' + el.id : ''), cls: 'canvas',
        x: r.left - ox, y: r.top - oy, w: r.width, h: r.height,
        fills: [{ type: 'IMAGE', imageId: id, scaleMode: 'FILL' }], children: []
      };
    }
  }

  /* svg → one vector node */
  if (tag === 'svg') {
    return {
      type: 'SVG', name: svgName(el) + (SNAPSHOT_MODE ? ' · ' + sourceKey : ''), sourceKey, cls: 'svg',
      x: r.left - ox, y: r.top - oy, w: r.width, h: r.height,
      svg: inlineSvg(el, doc, col(cs.color), win, r),
      opacity: parseFloat(cs.opacity)
    };
  }

  const node = {
    type: 'FRAME',
    name: nameFor(el, tag) + (SNAPSHOT_MODE ? ' · ' + sourceKey : ''), sourceKey,
    cls: tag + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
    x: r.left - ox, y: r.top - oy, w: r.width, h: r.height,
    fills: [], children: []
  };

  /* fills */
  const bgc = col(cs.backgroundColor);
  if (bgc) node.fills.push({ type: 'SOLID', color: bgc, opacity: bgc.a });
  const bgi = cs.backgroundImage;
  if (bgi && bgi !== 'none') {
    const g = gradient(bgi, r.width, r.height);
    if (g) node.fills.push(g);
    else {
      const um = bgi.match(/url\(["']?(data:image[^"')]+)["']?\)/);
      if (um) {
        const id = stashDataUri(um[1]);
        if (id) node.fills.push({ type: 'IMAGE', imageId: id, scaleMode: cs.backgroundSize === 'contain' ? 'FIT' : 'FILL' });
      }
    }
  }

  /* <img> */
  if (tag === 'img') {
    const id = stashDataUri(el.currentSrc || el.src);
    if (id) node.fills.push({ type: 'IMAGE', imageId: id, scaleMode: cs.objectFit === 'contain' ? 'FIT' : 'FILL' });
    else if (el.src && el.src.indexOf('data:') !== 0) WARN.push('Skipped a remote image: ' + el.src.slice(0, 60));
  }

  /* borders — uniform becomes a stroke, single-sided becomes a hairline rect */
  const bw = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)];
  const bc = [col(cs.borderTopColor), col(cs.borderRightColor), col(cs.borderBottomColor), col(cs.borderLeftColor)];
  const uniform = bw[0] && bw.every(v => Math.abs(v - bw[0]) < 0.01) && cs.borderStyle !== 'none';
  if (uniform && bc[0]) {
    node.strokes = [{ color: bc[0], opacity: bc[0].a }];
    node.strokeWeight = bw[0];
  } else {
    const sides = [[0,0,r.width,bw[0]], [r.width-bw[1],0,bw[1],r.height], [0,r.height-bw[2],r.width,bw[2]], [0,0,bw[3],r.height]];
    bw.forEach((w, i) => {
      if (w > 0 && bc[i]) node.children.push({
        type: 'FRAME', name: 'Border', x: sides[i][0], y: sides[i][1], w: sides[i][2] || w, h: sides[i][3] || w,
        fills: [{ type: 'SOLID', color: bc[i], opacity: bc[i].a }], children: []
      });
    });
  }

  const rad = radius(cs, r.width, r.height); if (rad) node.radius = rad;
  const eff = shadows(cs.boxShadow); if (eff.length) node.effects = eff;
  const op = parseFloat(cs.opacity); if (op < 1) node.opacity = op;
  if (cs.overflow === 'hidden' || cs.overflowY === 'hidden' || cs.overflowX === 'hidden') node.clip = true;

  /* absolutely-positioned pseudo elements (dividers, connectors, dots) */
  ['::before', '::after'].forEach(pe => {
    const p = win.getComputedStyle(el, pe);
    if (!p || p.content === 'none' || p.display === 'none') return;
    if (p.position !== 'absolute') return;
    const pc = col(p.backgroundColor);
    const pw = px(p.width), ph = px(p.height);
    if (!pc || !pw || !ph) return;
    let x = px(p.left), y = px(p.top);
    if (p.left === 'auto' && p.right !== 'auto') x = r.width - px(p.right) - pw;
    if (p.top === 'auto' && p.bottom !== 'auto') y = r.height - px(p.bottom) - ph;
    const prad = radius(p, pw, ph);
    const n = { type: 'FRAME', name: pe, x: x, y: y, w: pw, h: ph,
                fills: [{ type: 'SOLID', color: pc, opacity: pc.a }], children: [] };
    if (prad) n.radius = prad;
    node.children.push(n);
  });

  /* text runs */
  const mixed = isMixedInline(el, win);
  if (mixed) {
    const flat = flatten(el, win);
    const range = doc.createRange();
    range.selectNodeContents(el);
    const rects = range.getClientRects();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, lines = 0;
    for (const rc of rects) {
      if (rc.width < 0.2 && rc.height < 0.2) continue;
      x0 = Math.min(x0, rc.left); y0 = Math.min(y0, rc.top);
      x1 = Math.max(x1, rc.right); y1 = Math.max(y1, rc.bottom);
      lines++;
    }
    if (isFinite(x0) && flat.text) {
      const fam = (cs.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim();
      const fs0 = px(cs.fontSize);
      const base = col(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
      const styled = [];
      flat.runs.forEach(r => {
        const w = parseInt(r.cs.fontWeight, 10) || 400;
        const c = col(r.cs.color) || base;
        const it = r.cs.fontStyle === 'italic';
        const f = (r.cs.fontFamily || cs.fontFamily).split(',')[0].replace(/["']/g, '').trim();
        const same = w === (parseInt(cs.fontWeight, 10) || 400) &&
          Math.abs(c.r - base.r) < 0.004 && Math.abs(c.g - base.g) < 0.004 && Math.abs(c.b - base.b) < 0.004 &&
          !it && f === fam;
        if (!same) styled.push({ start: r.start, end: r.end, fontFamily: f, fontWeight: w, italic: it, color: c, colorOpacity: c.a });
      });
      used++;
      node.children.push({
        type: 'TEXT', name: nameFor(el, tag), cls: tag,
        chars: flat.text, lines: lines,
        x: x0 - r.left, y: y0 - r.top,
        w: Math.max(4, x1 - x0 + 1), h: Math.max(fs0, y1 - y0 + 1),
        fontFamily: fam, fontWeight: parseInt(cs.fontWeight, 10) || 400, italic: cs.fontStyle === 'italic',
        fontSize: fs0, lineHeight: cs.lineHeight === 'normal' ? fs0 * 1.2 : px(cs.lineHeight),
        letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
        align: { left: 'LEFT', right: 'RIGHT', center: 'CENTER', justify: 'JUSTIFIED',
                 start: 'LEFT', end: 'RIGHT' }[cs.textAlign] || 'LEFT',
        color: base, colorOpacity: base.a,
        runs: styled.length ? styled : null
      });
    }
  }

  const tns = mixed ? [] : textNodesOf(el);
  if (tns.length) {
    const fam = (cs.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim();
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const fs = px(cs.fontSize);
    let lh = cs.lineHeight === 'normal' ? fs * 1.2 : px(cs.lineHeight);
    const ls = cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing);
    const tcol = col(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    const align = { left: 'LEFT', right: 'RIGHT', center: 'CENTER', justify: 'JUSTIFIED',
                    start: 'LEFT', end: 'RIGHT' }[cs.textAlign] || 'LEFT';
    const deco = cs.textDecorationLine && cs.textDecorationLine.indexOf('underline') > -1 ? 'UNDERLINE'
               : (cs.textDecorationLine && cs.textDecorationLine.indexOf('line-through') > -1 ? 'STRIKETHROUGH' : null);
    const tcase = { uppercase: 'UPPER', lowercase: 'LOWER', capitalize: 'TITLE' }[cs.textTransform] || null;

    tns.forEach(tn => {
      const range = doc.createRange(); range.selectNodeContents(tn);
      const rects = range.getClientRects();
      if (!rects.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const rc of rects) {
        if (rc.width < 0.2 && rc.height < 0.2) continue;
        x0 = Math.min(x0, rc.left); y0 = Math.min(y0, rc.top);
        x1 = Math.max(x1, rc.right); y1 = Math.max(y1, rc.bottom);
      }
      if (!isFinite(x0)) return;
      let lines = 0;
      for (const rc of rects) if (rc.width >= 0.2 || rc.height >= 0.2) lines++;
      used++;
      node.children.push({
        type: 'TEXT',
        chars: tn.nodeValue.replace(/\s+/g, ' ').trim(),
        lines: lines,
        x: x0 - r.left, y: y0 - r.top,
        w: Math.max(4, x1 - x0 + 1), h: Math.max(fs, y1 - y0 + 1),
        fontFamily: fam, fontWeight: weight, italic: cs.fontStyle === 'italic',
        fontSize: fs, lineHeight: lh, letterSpacing: ls,
        align: align, decoration: deco, transform: tcase,
        color: tcol, colorOpacity: tcol.a
      });
    });
  }

  if (tag === 'select') {
    const opt = el.options && el.options[el.selectedIndex];
    const v = opt ? (opt.textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (v) {
      const fam = (cs.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim();
      const tcol = col(cs.color) || { r: .2, g: .2, b: .2, a: 1 };
      used++;
      node.children.push({
        type: 'TEXT', name: 'Select · ' + v.slice(0, 24), cls: 'select',
        chars: v, lines: 1,
        x: px(cs.paddingLeft) + px(cs.borderLeftWidth),
        y: (r.height - px(cs.fontSize) * 1.25) / 2,
        w: Math.max(10, r.width - px(cs.paddingLeft) - px(cs.paddingRight)),
        h: px(cs.fontSize) * 1.3,
        fontFamily: fam, fontWeight: parseInt(cs.fontWeight, 10) || 400, italic: false,
        fontSize: px(cs.fontSize), lineHeight: px(cs.fontSize) * 1.3, letterSpacing: 0,
        align: 'LEFT', color: tcol, colorOpacity: tcol.a
      });
    }
  }

  /* form fields carry their value as text */
  if (tag === 'input' || tag === 'textarea') {
    const v = el.type === 'password' ? '••••••••' : (el.value || el.getAttribute('placeholder') || '');
    if (v.trim()) {
      const fam = (cs.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim();
      const tcol = col(el.value ? cs.color : 'rgba(0,0,0,0.42)') || { r: .5, g: .5, b: .5, a: 1 };
      node.children.push({
        type: 'TEXT', chars: v, x: px(cs.paddingLeft) + px(cs.borderLeftWidth),
        y: (r.height - px(cs.fontSize) * 1.25) / 2, w: Math.max(10, r.width - px(cs.paddingLeft) - px(cs.paddingRight)),
        h: px(cs.fontSize) * 1.3,
        fontFamily: fam, fontWeight: parseInt(cs.fontWeight, 10) || 400, italic: false,
        fontSize: px(cs.fontSize), lineHeight: px(cs.fontSize) * 1.3, letterSpacing: 0,
        align: 'LEFT', color: tcol, colorOpacity: tcol.a
      });
    }
  }

  /* children */
  for (const ch of Array.from(el.children).sort((a, b) => (parseInt(win.getComputedStyle(a).zIndex) || 0) - (parseInt(win.getComputedStyle(b).zIndex) || 0))) {
    if (tag === 'svg') break;
    if (mixed) break;
    const c = walk(ch, win, r.left, r.top, depth + 1);
    if (c) node.children.push(c);
  }
  return node;
}

/* ── CSS custom properties → tokens ───────────────────────────────────── */
function tokens(win) {
  const doc = win.document, out = [], seen = {};
  const light = {}, dark = {};
  const SIMPLE = /^(:root|html|body|\.[\w-]+|#[\w-]+)$/;

  function eat(rule, isDark) {
    if (!rule.style || !rule.selectorText) return;
    const sels = rule.selectorText.split(',').map(x => x.replace(/\s+/g, ''));
    const darkSel = sels.some(x => /data-theme=["']?dark/.test(x));
    const rootish = sels.some(x => SIMPLE.test(x) || /data-theme=["']?dark/.test(x.replace(/^:root/, ':root')));
    if (!rootish && !darkSel) return;
    let n = 0;
    for (let i = 0; i < rule.style.length; i++) if (rule.style[i].indexOf('--') === 0) n++;
    if (n < 3) return;                       /* a real token block, not a one-off */
    const bag = (isDark || darkSel) ? dark : light;
    for (let i = 0; i < rule.style.length; i++) {
      const prop = rule.style[i];
      if (prop.indexOf('--') !== 0) continue;
      bag[prop] = rule.style.getPropertyValue(prop).trim();
    }
  }

  function scan(rules, isDark) {
    if (!rules) return;
    for (const rule of rules) {
      if (rule.media) scan(rule.cssRules, isDark || /prefers-color-scheme:\s*dark/.test(rule.conditionText || rule.media.mediaText || ''));
      else if (rule.cssRules && rule.cssRules.length && !rule.selectorText) scan(rule.cssRules, isDark);
      else eat(rule, isDark);
    }
  }

  for (const sheet of doc.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    scan(rules, false);
  }

  const probe = doc.createElement('div');
  probe.style.position = 'absolute'; probe.style.left = '-9999px';
  doc.body.appendChild(probe);
  const resolve = v => {
    if (!v) return null;
    probe.style.color = 'rgb(1,2,3)';
    probe.style.color = v;
    const c = col(win.getComputedStyle(probe).color);
    if (!c) return null;
    if (Math.abs(c.r*255-1) < .5 && Math.abs(c.g*255-2) < .5 && Math.abs(c.b*255-3) < .5) return null;
    return c;
  };
  for (const name in light) {
    const v = light[name];
    if (!/^(#|rgb|hsl)/i.test(v)) continue;
    const c = resolve(v); if (!c) continue;
    if (seen[name]) continue; seen[name] = 1;
    const d = dark[name] ? resolve(dark[name]) : null;
    out.push({ name: name, light: c, dark: d });
  }
  probe.remove();
  return { colors: out, hasDark: Object.keys(dark).length > 0 };
}

/* ── screens ──────────────────────────────────────────────────────────── */
function findScreens(win, sel) {
  const els = Array.prototype.slice.call(win.document.querySelectorAll(sel));
  return els.map((el, i) => ({
    el: el,
    id: el.getAttribute('data-screen') || el.id || ('screen-' + i),
    name: el.getAttribute('data-screen') || el.id || ('Screen ' + (i + 1))
  }));
}

function freeze(win, on) {
  const doc = win.document;
  let st = doc.getElementById('__pe_freeze');
  if (on) {
    if (!st) {
      st = doc.createElement('style'); st.id = '__pe_freeze';
      st.textContent = '*,*::before,*::after{animation:none!important;' +
        'transition:none!important;animation-delay:0s!important;animation-duration:0s!important}' +
        /* transient notices raised by the plugin's own clicking are not part
           of the screen a designer is laying out */
        '[class*="toast"],[class*="snackbar"],[role="status"]{display:none!important}';
      doc.head.appendChild(st);
    }
  } else if (st) st.remove();
}

let EXPANDED = [];
function expand(win, on) {
  const doc = win.document;
  let st = doc.getElementById('__pe_expand');
  if (!on) {
    EXPANDED.forEach(p => { p[0].style.cssText = p[1]; });
    EXPANDED = [];
    if (st) st.remove();
    return;
  }
  if (!st) {
    st = doc.createElement('style'); st.id = '__pe_expand';
    st.textContent = 'html,body{height:auto!important;overflow:visible!important}';
    doc.head.appendChild(st);
  }
  /* two passes: release the clip, reflow, then pin anything still cut off */
  for (let pass = 0; pass < 2; pass++) {
    const all = doc.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (SKIP_TAGS[el.tagName]) continue;
      if (el.scrollHeight <= el.clientHeight + 4 && el.scrollWidth <= el.clientWidth + 4) continue;
      const cs = win.getComputedStyle(el);
      if (!/auto|scroll|hidden/.test(cs.overflowY + ' ' + cs.overflowX)) continue;
      EXPANDED.push([el, el.style.cssText]);
      const want = el.scrollHeight;
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('height', want + 'px', 'important');
      el.style.setProperty('min-height', want + 'px', 'important');
    }
    doc.documentElement.offsetHeight;
  }
}

function activate(win, screens, target, activeClass) {
  screens.forEach(s => { if (s.el !== target.el) s.el.classList.remove(activeClass); });
  target.el.classList.add(activeClass);
}

/* ── finding the way into a screen ─────────────────────────────────────
   A detail screen is usually empty until the app fills it in, and the code
   that fills it is private to the page — a transaction screen is blank until
   something calls openTx(). There is no way to call it from outside, but
   there is always a way to *click* it: the row the user would click. So try
   the clicks a user has available and note which one lands on which screen. */

function cssEsc(v) { return String(v).replace(/["\\]/g, '\\$&'); }

function selectorFor(el) {
  if (el.id) return '#' + el.id;
  const ds = el.dataset ? Object.keys(el.dataset) : [];
  for (const k of ds) {
    const attr = 'data-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    const val = el.getAttribute(attr);
    if (val === null) continue;
    const sel = '[' + attr + '="' + cssEsc(val) + '"]';
    try { if (el.ownerDocument.querySelectorAll(sel).length >= 1) return sel; } catch (e) {}
  }
  return null;
}

function shut(win) {
  const doc = win.document;
  const closers = doc.querySelectorAll('[data-close]');
  for (let i = 0; i < closers.length; i++) { try { closers[i].click(); } catch (e) {} }
  const veil = doc.getElementById('veil');
  if (veil) veil.classList.remove('on');
}

const ROWSEL = '[data-tx],[data-mer],[data-id],[data-ref],[data-open],[data-row],' +
               '[data-plate],[data-pass],[data-merchant],[data-view],[data-detail],[data-case]';

function openers(win, sel, activeClass) {
  const doc = win.document;
  const screens = findScreens(win, sel);
  const want = {};
  screens.forEach(s => { want[s.id] = 1; });
  const map = {};
  const left = () => Object.keys(want).length;

  /* the easy half: whatever the navigation reaches directly */
  screens.forEach(s => {
    const nav = doc.querySelector('[data-go="' + cssEsc(s.id) + '"]');
    if (nav) { map[s.id] = '[data-go="' + cssEsc(s.id) + '"]'; delete want[s.id]; }
  });
  if (!left()) return map;

  /* the rest are detail screens. Walk each screen in turn and click the rows
     inside it — a row only exists while its own screen is up. */
  const start = screens.filter(s => s.el.classList.contains(activeClass))[0] || screens[0];
  for (const s of screens) {
    if (!left()) break;
    activate(win, screens, s, activeClass);
    const rows = s.el.querySelectorAll(ROWSEL);
    for (let i = 0; i < rows.length && i < 120; i++) {
      if (!left()) break;
      const sf = selectorFor(rows[i]);
      if (!sf) continue;
      try { rows[i].click(); } catch (e) { continue; }
      const on = doc.querySelector('.' + activeClass);
      const landed = on && on.getAttribute ? on.getAttribute('data-screen') : null;
      if (landed && want[landed]) { map[landed] = sf; delete want[landed]; }
      shut(win);
      if (landed !== s.id) activate(win, screens, s, activeClass);
    }
  }

  activate(win, screens, start, activeClass);
  return map;
}

/* the app shell worth capturing around a screen */
function autoRoot(win, screenEl) {
  const doc = win.document;
  const pick = ['#appRoot', '#app', '.app', '.layout > .main'];
  for (const sel of pick) {
    const el = doc.querySelector(sel);
    if (el && el.contains(screenEl) && el.getBoundingClientRect().width > 1) return el;
  }
  return screenEl;
}

/* ── screens that are not screens ──────────────────────────────────────
   Sign-in, sign-up and the rest of an auth flow are often one container whose
   contents get swapped, not separate sections — so no selector can find them,
   and they are gone the moment the app logs in. Find the container, find the
   buttons that swap it, and treat each state as a screen of its own. */

const VIEW_ATTRS = ['data-auth', 'data-view', 'data-step', 'data-pane'];

function bigRoot(win, el) {
  const vw = win.innerWidth, vh = win.innerHeight;
  let best = null, node = el;
  while (node && node.tagName && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
    const r = node.getBoundingClientRect();
    if (r.width >= vw * 0.5 && r.height >= vh * 0.4) best = node;
    node = node.parentElement;
  }
  if (!best) return null;
  if (best.id) return '#' + best.id;
  const c = best.className && typeof best.className === 'string' ? best.className.trim().split(/\s+/)[0] : '';
  return c ? '.' + c : null;
}

/* A state behind a form — the onboarding flow after sign-up — is only
   reachable by filling the form in. The placeholders say what each field
   wants, so use them, then press whatever submits. */
function autofill(box, w) {
  if (w) win0 = w;
  const ins = box.querySelectorAll('input, textarea');
  for (let i = 0; i < ins.length; i++) {
    const el = ins[i];
    const t = (el.type || 'text').toLowerCase();
    if (t === 'checkbox' || t === 'radio' || t === 'hidden' || el.disabled || el.value) continue;
    const ph = (el.getAttribute('placeholder') || '').trim();
    const cap = el.maxLength > 0 ? el.maxLength : 24;
    /* a one-character box with inputmode="numeric" and no name at all is a
       verification-code digit — read every hint the markup offers */
    const hint = [el.id, el.name, ph, el.getAttribute('inputmode'), el.getAttribute('pattern'),
      el.className, el.parentElement ? el.parentElement.className : ''].join(' ');
    const numeric = t === 'tel' || t === 'number' ||
      /phone|pin|code|otp|digit|number|numeric|tel|\[0-9\]|\\d/i.test(hint) || cap <= 6;
    if (t === 'email' || /mail/i.test(hint)) el.value = /@/.test(ph) ? ph : 'name@example.com';
    else if (numeric) el.value = ((ph.replace(/\D/g, '') || '') + '0913552077').slice(0, Math.min(cap, 10));
    else el.value = (ph || 'Example').slice(0, cap);
    try { el.dispatchEvent(new win0.Event('input', { bubbles: true })); } catch (e) {}
  }
  const submit = box.querySelector('button[type="submit"], button[id^="do"], button[id^="Do"]');
  if (submit) { try { submit.click(); return true; } catch (e) {} }
  return false;
}

let win0 = null;
function viewsOf(win) {
  win0 = win;
  const doc = win.document;
  let attr = null, els = null;
  for (const a of VIEW_ATTRS) {
    const found = doc.querySelectorAll('[' + a + ']');
    if (found.length) { attr = a; els = found; break; }
  }
  if (!attr) return null;

  const root = bigRoot(win, els[0]);
  if (!root) return null;

  /* the smallest thing that holds every one of those buttons is the box
     whose contents get swapped */
  let box = els[0].parentElement;
  for (let i = 1; i < els.length && box; i++) {
    while (box && !box.contains(els[i])) box = box.parentElement;
  }
  const boxSel = box && box !== doc.body
    ? (box.id ? '#' + box.id
      : (box.className && typeof box.className === 'string'
        ? '.' + box.className.trim().split(/\s+/)[0] : null))
    : null;

  const seen = {}, views = [];
  function harvest() {
    const found = doc.querySelectorAll('[' + attr + ']');
    for (let i = 0; i < found.length; i++) {
      const v = found[i].getAttribute(attr);
      if (!v || seen[v]) continue;
      seen[v] = 1;
      views.push({ id: v, name: v, click: '[' + attr + '="' + cssEsc(v) + '"]' });
    }
  }
  harvest();

  /* whichever state the page opens in has no button pointing at it */
  if (!seen['start'] && (!views.length || !doc.querySelector(views[0].click))) {
    views.unshift({ id: 'start', name: 'start', click: '' });
    seen['start'] = 1;
  }

  const alive = () => {
    const r = doc.querySelector(root);
    return r && r.getBoundingClientRect().width > 1;
  };
  const headOf = () => {
    const bx = boxSel && doc.querySelector(boxSel);
    if (!bx) return '';
    const h = bx.querySelector('h1,h2,h3,legend');
    return h ? (h.textContent || '').replace(/\s+/g, ' ').trim() : '';
  };
  const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
  const headSeen = {};

  /* phase one — follow the buttons, which is safe */
  for (let round = 0; round < 4; round++) {
    const before = views.length;
    for (const v of views.slice()) {
      if (!alive()) break;
      if (v.click && typeof v.click === 'string') {
        const el = doc.querySelector(v.click);
        if (!el) continue;
        try { el.click(); } catch (e) { continue; }
        doc.documentElement.offsetHeight;
      }
      headSeen[headOf()] = 1;
      harvest();
    }
    if (views.length === before || !alive()) break;
  }

  /* phase two — walk the forms. Submitting one can sign the app in and take
     the whole container away, so keep a copy of the page to put back. The
     app's own click handling lives on `document`, which survives the swap. */
  const snap = doc.body.innerHTML;
  const restore = () => {
    doc.body.innerHTML = snap;
    doc.documentElement.offsetHeight;
  };
  if (!alive()) restore();

  for (const v of views.slice()) {
    if (v.fill) continue;
    restore();
    if (v.click && typeof v.click === 'string') {
      const el = doc.querySelector(v.click);
      if (!el) continue;
      try { el.click(); } catch (e) { continue; }
      doc.documentElement.offsetHeight;
    }
    for (let step = 1; step <= 3; step++) {
      const bx = boxSel && doc.querySelector(boxSel);
      if (!bx || !alive()) break;
      if (!autofill(bx)) break;
      doc.documentElement.offsetHeight;
      if (!alive()) break;
      harvest();
      const h = headOf();
      if (h && !headSeen[h]) {
        headSeen[h] = 1;
        const id = slug(h);
        if (!seen[id]) {
          seen[id] = 1;
          views.push({ id: id, name: id, click: v.click ? [v.click] : [], fill: step });
        }
      }
    }
  }
  restore();

  return { root: root, box: boxSel, attr: attr, views: views, present: !!doc.querySelector(root) };
}

/* The button that opens "sign up" only exists on the sign-in view. If we have
   navigated away, click around until it is back on screen. */
function reach(win, v, views, attr) {
  const doc = win.document;
  if (!v.click || doc.querySelector(v.click)) return true;
  const tries = [];
  for (const o of views) if (o !== v && o.click) tries.push(o.click);
  if (attr) tries.push('[' + attr + ']');
  for (let pass = 0; pass < 3; pass++) {
    for (const sel of tries) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      try { el.click(); } catch (e) { continue; }
      doc.documentElement.offsetHeight;
      if (doc.querySelector(v.click)) return true;
    }
  }
  return !!doc.querySelector(v.click);
}

/* the words on a view, so it is not called "start" in the layer list */
function viewLabel(win, boxSel, fallback) {
  const box = boxSel && win.document.querySelector(boxSel);
  if (!box) return fallback;
  const h = box.querySelector('h1,h2,h3,legend');
  const t = h && (h.textContent || '').replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || fallback;
}

function captureOne(win, rootSel, opts, id, name) {
  const rootEl = win.document.querySelector(rootSel) || win.document.body;
  if (opts.expand) expand(win, true);
  win.document.documentElement.offsetHeight;
  let r = rootEl.getBoundingClientRect();
  used = 0;
  let tree = walk(rootEl, win, r.left, r.top, 0);
  if (!tree && opts.expand) {
    expand(win, false);
    win.document.documentElement.offsetHeight;
    r = rootEl.getBoundingClientRect();
    used = 0;
    tree = walk(rootEl, win, r.left, r.top, 0);
  }
  if (opts.expand) expand(win, false);
  if (!tree) return null;
  tree.x = 0; tree.y = 0; tree.name = name;
  return { id: id, name: name, tree: fit(tree) };
}

/* ── modals, sheets and drawers ─────────────────────────────────────────
   These are screens too — a designer has to lay out the export dialog and the
   switch-facility sheet like anything else — but they live outside the screen
   they open over and only exist once something is clicked. */

const OVERLAY_ATTRS = ['data-modal', 'data-sheet', 'data-dialog', 'data-drawer', 'data-popup'];

function overlaysOf(win, sel) {
  const doc = win.document;
  const out = [], seen = {};
  for (const a of OVERLAY_ATTRS) {
    const els = doc.querySelectorAll('[' + a + ']');
    for (let i = 0; i < els.length; i++) {
      const v = els[i].getAttribute(a);
      if (!v || seen[a + '|' + v]) continue;
      seen[a + '|' + v] = 1;
      let host = null;
      try { host = els[i].closest(sel); } catch (e) {}
      out.push({
        id: v, name: v, attr: a,
        click: '[' + a + '="' + cssEsc(v) + '"]',
        screen: host ? (host.getAttribute('data-screen') || host.id || '') : ''
      });
    }
  }
  return out;
}

/* Expanding a pane can leave content standing past the bottom of the shell
   that was sized to the window. Grow the screen frame so nothing is cut. */
function fit(tree) {
  let right = tree.w, bottom = tree.h;
  (function scan(n, ox, oy) {
    const x = ox + n.x, y = oy + n.y;
    right = Math.max(right, x + n.w);
    bottom = Math.max(bottom, y + n.h);
    (n.children || []).forEach(c => scan(c, x, y));
  })(tree, 0, 0);
  tree.w = Math.ceil(Math.max(tree.w, right));
  tree.h = Math.ceil(Math.max(tree.h, bottom));
  return tree;
}

/* ── public API ───────────────────────────────────────────────────────── */
root.PrototypeExtract = {
  snapshot: function (win, opts) {
    IMAGES = {}; IMGSEEN = {}; imgSeq = 0; used = 0; WARN = [];
    SNAPSHOT_ASSETS = opts.assets || {}; SNAPSHOT_MODE = true; NODE_BUDGET = opts.maxNodes || 10000;
    try {
      const body = walk(win.document.body, win, -win.scrollX, -win.scrollY, 0);
      const bg = col(win.getComputedStyle(win.document.documentElement).backgroundColor) || {r:1,g:1,b:1,a:1};
      const tree = { type: 'FRAME', name: 'Page', x:0, y:0, w:opts.width, h:opts.height, clip:true,
        fills:[{type:'SOLID',color:bg,opacity:bg.a}], children:body ? [body] : [] };
      if (!body) WARN.push('The page has no visible body.');
      return {tree:tree,images:IMAGES,warnings:WARN,nodes:used};
    } finally { SNAPSHOT_ASSETS = null; SNAPSHOT_MODE = false; }
  },
  listScreens: function (win, sel) {
    return findScreens(win, sel).map(s => ({ id: s.id, name: s.name }));
  },
  tokens: tokens,
  openers: function (win, sel, activeClass) {
    freeze(win, true);
    let m = {};
    try { m = openers(win, sel, activeClass || 'on'); } catch (e) { WARN.push('opener probe: ' + e.message); }
    freeze(win, false);
    return m;
  },
  views: function (win) { try { return viewsOf(win); } catch (e) { return null; } },

  /* a language switch, if the prototype has one */
  languages: function (win) {
    const doc = win.document;
    const out = [];
    const els = doc.querySelectorAll('[data-lang]');
    for (let i = 0; i < els.length; i++) {
      const v = els[i].getAttribute('data-lang');
      if (!v || out.some(o => o.code === v)) continue;
      out.push({
        code: v,
        label: (els[i].textContent || v).replace(/\s+/g, ' ').trim().slice(0, 24),
        click: '[data-lang="' + cssEsc(v) + '"]',
        current: els[i].getAttribute('aria-pressed') === 'true'
      });
    }
    return out;
  },

  /* each swapped state of one container, captured as its own screen */
  captureViews: function (win, opts) {
    IMAGES = {}; imgSeq = 0; used = 0; WARN = []; IMGSEEN = {};
    freeze(win, true);
    const out = [];
    let total = 0;
    const todo = (opts.views || []).slice();
    const want = opts.only && opts.only.length ? opts.only : null;
    const usedLabel = {};

    /* a state's button may only exist on another state, so keep going round */
    for (let round = 0; round < 4 && todo.length; round++) {
      const again = [];
      for (const v of todo) {
        if (want && want.indexOf(v.id) < 0) continue;
        /* click may be one selector or a short sequence, for a state that
           takes more than one step to reach */
        const steps = v.click ? (typeof v.click === 'string' ? [v.click] : v.click) : [];
        let stuck = false;
        for (let k = 0; k < steps.length; k++) {
          const step = { click: steps[k] };
          if (k === 0 && !reach(win, step, opts.views, opts.attr)) { stuck = true; break; }
          const el = win.document.querySelector(steps[k]);
          if (!el) { stuck = true; break; }
          try { el.click(); } catch (e) { WARN.push('could not open ' + v.id); stuck = true; break; }
          win.document.documentElement.offsetHeight;
        }
        if (stuck) { again.push(v); continue; }
        for (let f = 0; f < (v.fill || 0); f++) {
          const bx = opts.box && win.document.querySelector(opts.box);
          if (!bx) break;
          autofill(bx, win);
          win.document.documentElement.offsetHeight;
        }
        if (v.run) {
          try { (new win.Function(v.run))(); } catch (e) { WARN.push(v.id + ' setup: ' + e.message); }
        }
        win.document.documentElement.offsetHeight;
        const label = viewLabel(win, opts.box, v.name);
        if (usedLabel[label]) continue;          // the same view under another name
        usedLabel[label] = 1;
        const got = captureOne(win, opts.root, opts, (opts.prefix || '') + v.id, (opts.prefix || '') + label);
        total += used;
        if (got) out.push(got);
      }
      if (again.length === todo.length) break;
      todo.length = 0;
      Array.prototype.push.apply(todo, again);
    }
    freeze(win, false);
    return { screens: out, images: IMAGES, warnings: WARN, nodes: total };
  },

  overlays: function (win, sel) {
    try { return overlaysOf(win, sel || 'section.screen'); } catch (e) { return []; }
  },

  captureOverlays: function (win, opts) {
    IMAGES = {}; imgSeq = 0; used = 0; WARN = []; IMGSEEN = {};
    freeze(win, true);
    const doc = win.document;
    const screens = findScreens(win, opts.selector);
    const out = [];
    let total = 0;
    const want = opts.only && opts.only.length ? opts.only : null;

    (opts.items || []).forEach(it => {
      if (want && want.indexOf(it.id) < 0) return;
      shut(win);
      /* stand on the screen the trigger belongs to, so the dialog opens over
         the right thing and the trigger is actually on the page */
      if (it.screen) {
        const t = screens.filter(s => s.id === it.screen)[0];
        if (t) activate(win, screens, t, opts.activeClass);
      }
      doc.documentElement.offsetHeight;
      const btn = doc.querySelector(it.click);
      if (!btn) { WARN.push('no way to open ' + it.id); return; }
      try { btn.click(); } catch (e) { WARN.push('could not open ' + it.id); return; }
      doc.documentElement.offsetHeight;
      const got = captureOne(win, opts.root || 'body', opts,
        (opts.prefix || '') + it.id, (opts.prefix || '') + it.name);
      total += used;
      if (got) out.push(got);
      shut(win);
    });

    freeze(win, false);
    return { screens: out, images: IMAGES, warnings: WARN, nodes: total };
  },

  autoRoot: function (win, sel) {
    const screens = findScreens(win, sel);
    if (!screens.length) return 'body';
    const el = autoRoot(win, screens[0].el);
    return el.id ? '#' + el.id : (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/)[0] : el.tagName.toLowerCase());
  },
  capture: function (win, opts) {
    IMAGES = {}; imgSeq = 0; used = 0; WARN = []; IMGSEEN = {};
    freeze(win, true);
    const screens = findScreens(win, opts.selector);
    const pick = opts.only && opts.only.length
      ? screens.filter(s => opts.only.indexOf(s.id) > -1) : screens;
    const out = [];
    let total = 0;
    pick.forEach(s => {
      const how = opts.openers && opts.openers[s.id];
      if (how) {
        const el = win.document.querySelector(how);
        if (el) { try { el.click(); } catch (e) { WARN.push('could not open ' + s.id); } }
      }
      activate(win, screens, s, opts.activeClass);
      if (opts.hook) {
        try { (new win.Function('screen', opts.hook))(s.id); }
        catch (e) { WARN.push('setup for ' + s.id + ': ' + e.message); }
      }
      if (opts.expand) expand(win, true);
      win.document.documentElement.offsetHeight;      // force layout
      const pickRoot = () => opts.root && win.document.querySelector(opts.root)
        ? win.document.querySelector(opts.root) : autoRoot(win, s.el);
      let rootEl = pickRoot();
      let r = rootEl.getBoundingClientRect();
      used = 0;
      let tree = walk(rootEl, win, r.left, r.top, 0);

      /* expanding a scrolling pane can collapse a shell that was sized to the
         window. If that happened, put it back and take the plain capture. */
      if (!tree && opts.expand) {
        expand(win, false);
        win.document.documentElement.offsetHeight;
        rootEl = pickRoot();
        r = rootEl.getBoundingClientRect();
        used = 0;
        tree = walk(rootEl, win, r.left, r.top, 0);
        WARN.push(s.id + ': captured without expanding, the layout needed its own height');
      }
      total += used;
      if (tree) { tree.x = 0; tree.y = 0; tree.name = s.name; out.push({ id: s.id, name: s.name, tree: fit(tree) }); }
      if (opts.expand) expand(win, false);
    });
    freeze(win, false);
    return { screens: out, images: IMAGES, warnings: WARN, nodes: total };
  }
};

})(typeof window !== 'undefined' ? window : this);
