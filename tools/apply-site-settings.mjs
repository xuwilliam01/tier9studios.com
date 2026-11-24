// Writes the site editor's settings into the site's files, so the published pages carry them as plain HTML
// and CSS: no settings file is downloaded, and nothing changes after the page has drawn.
//
//   node tools/apply-site-settings.mjs <site-settings.json>
//
// The file is what the editor's "Export JSON" button saves (the editor is a team-site plan; tools/site-editor/
// builds it). Version 1 has four optional parts:
//
//   copy    { "<key>": "text" }  the text of every element with data-site-copy="<key>", on every page
//   colors  { ink, inkDim, accent, enter, enterHover, blurple }: "#rrggbb", the custom properties in site.css
//   motion  { mode, biome, rotateBiomes, intervalSeconds } go to world.js's MOTION line; blurPx to site.css
//   team    { members: [{ id, name, role, photo }] }  the whole team list on the home page, in order. photo is
//           a path under /assets/img/team/, a data: URL of an uploaded WebP, PNG or JPEG (saved there as
//           <id>.<type>), or null for the person's initial. Photos no member uses any more are deleted.
//
// A part or key the file leaves out keeps what the site has. Anything unknown or malformed stops the script
// before it writes a file. Run it from anywhere; it finds the site from its own path.
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'careers/index.html', 'careers/position/index.html', 'careers/privacy/index.html', '404.html'];
const CSS = 'assets/site/site.css';
const WORLD = 'assets/site/world.js';
const TEAM_DIR = 'assets/img/team';
const COLORS = { ink: '--ink', inkDim: '--ink-dim', accent: '--accent', enter: '--enter', enterHover: '--enter-hover', blurple: '--blurple' };
const PHOTO_TYPES = { webp: 'webp', png: 'png', jpeg: 'jpg' };
const MAX_PHOTO_BYTES = 200 * 1024;

const fail = message => { console.error('apply-site-settings: ' + message); process.exit(1); };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const escapeText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = s => escapeText(s).replace(/"/g, '&quot;');

const file = process.argv[2];
if (!file) fail('usage: node tools/apply-site-settings.mjs <site-settings.json>');
let settings;
try { settings = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { fail(`cannot read ${file}: ${e.message}`); }
if (!isObject(settings) || settings.version !== 1) fail('expected version 1 of the site editor settings');
for (const key of Object.keys(settings)) {
  if (!['version', 'copy', 'colors', 'motion', 'team'].includes(key)) fail(`unknown part "${key}"`);
}

// Every file is read once, changed in memory, and written at the end only if every check passed.
const files = new Map();
const read = rel => {
  if (!files.has(rel)) files.set(rel, { before: readFileSync(path.join(ROOT, rel), 'utf8') });
  const f = files.get(rel);
  return f.after ?? f.before;
};
const write = (rel, text) => { read(rel); files.get(rel).after = text; };
const report = [];

// ---- copy ----
const copy = settings.copy ?? {};
if (!isObject(copy)) fail('copy must be an object');
for (const [key, text] of Object.entries(copy)) {
  if (!/^[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(key)) fail(`copy key "${key}" is not a section.name key`);
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) fail(`copy "${key}" must be 1 to 2000 characters of text`);
  let found = 0;
  for (const page of PAGES) {
    const html = read(page);
    const rx = new RegExp(`(<([a-z0-9]+)\\b[^>]*\\bdata-site-copy="${key.replace('.', '\\.')}"[^>]*>)([\\s\\S]*?)(</\\2>)`, 'g');
    const next = html.replace(rx, (all, open, tag, inner, close) => {
      if (inner.includes('<')) fail(`the element for "${key}" in ${page} holds markup, so its text cannot be replaced`);
      found++;
      return open + escapeText(text.trim()) + close;
    });
    write(page, next);
  }
  if (!found) fail(`no page has an element with data-site-copy="${key}"`);
  report.push(`copy ${key}`);
}

// ---- colors ----
const colors = settings.colors ?? {};
if (!isObject(colors)) fail('colors must be an object');
for (const [name, value] of Object.entries(colors)) {
  const prop = COLORS[name];
  if (!prop) fail(`unknown color "${name}"`);
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail(`color "${name}" must be #rrggbb`);
  const css = read(CSS);
  const rx = new RegExp(`(\\n    ${prop}: )#[0-9a-fA-F]{6};`);
  if (!rx.test(css)) fail(`site.css has no ${prop} in :root`);
  write(CSS, css.replace(rx, `$1${value.toLowerCase()};`));
  report.push(`color ${name}`);
}

// ---- motion ----
const motion = settings.motion ?? {};
if (!isObject(motion)) fail('motion must be an object');
const biomeIds = JSON.parse(readFileSync(path.join(ROOT, 'assets/abw/biomes.json'), 'utf8')).map(b => b.id);
const worldRx = /var MOTION = (\{.*\});/;
const world = read(WORLD);
const worldMatch = world.match(worldRx);
if (!worldMatch) fail('world.js has no MOTION line');
const scene = JSON.parse(worldMatch[1]);
for (const [name, value] of Object.entries(motion)) {
  if (name === 'blurPx') {
    if (!Number.isFinite(value) || value < 0 || value > 24) fail('motion.blurPx must be 0 to 24');
    const css = read(CSS);
    const rx = /(\n    --site-blur: )[0-9.]+px;/;
    if (!rx.test(css)) fail('site.css has no --site-blur in :root');
    write(CSS, css.replace(rx, `$1${value}px;`));
  } else if (name === 'mode') {
    if (!['auto', 'still'].includes(value)) fail('motion.mode must be "auto" or "still"');
    scene.mode = value;
  } else if (name === 'biome') {
    if (value !== 'random' && !biomeIds.includes(value)) fail(`motion.biome must be "random" or one of ${biomeIds.join(', ')}`);
    scene.biome = value;
  } else if (name === 'rotateBiomes') {
    if (typeof value !== 'boolean') fail('motion.rotateBiomes must be true or false');
    scene.rotateBiomes = value;
  } else if (name === 'intervalSeconds') {
    if (!Number.isInteger(value) || value < 5 || value > 120) fail('motion.intervalSeconds must be a whole number from 5 to 120');
    scene.intervalSeconds = value;
  } else {
    fail(`unknown motion setting "${name}"`);
  }
  report.push(`motion ${name}`);
}
write(WORLD, world.replace(worldRx, `var MOTION = ${JSON.stringify(scene)};`));

// ---- team ----
const photoWrites = new Map(); // file name -> bytes
if (settings.team !== undefined) {
  const team = settings.team;
  if (!isObject(team) || !Array.isArray(team.members) || Object.keys(team).some(k => k !== 'members')) {
    fail('team must be { members: [...] }');
  }
  if (!team.members.length || team.members.length > 60) fail('the team list holds 1 to 60 people');
  const ids = new Set();
  const keep = new Set();
  const items = team.members.map((m, i) => {
    const where = `team member ${i + 1}`;
    if (!isObject(m)) fail(`${where} must be an object`);
    for (const k of Object.keys(m)) if (!['id', 'name', 'role', 'photo'].includes(k)) fail(`${where} has an unknown field "${k}"`);
    if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(m.id)) fail(`${where}: id must be 1 to 40 lowercase letters, digits or hyphens`);
    if (ids.has(m.id)) fail(`${where}: the id "${m.id}" is used twice`);
    ids.add(m.id);
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) fail(`${where}: name must be 1 to 60 characters`);
    const role = m.role ?? '';
    if (typeof role !== 'string' || role.length > 60) fail(`${where}: role must be at most 60 characters`);
    let src = null;
    if (typeof m.photo === 'string' && m.photo.startsWith('data:')) {
      const dm = m.photo.match(/^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!dm) fail(`${where}: the photo must be a base64 WebP, PNG or JPEG`);
      const bytes = Buffer.from(dm[2], 'base64');
      const magic = { webp: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
        png: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        jpeg: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff };
      if (!magic[dm[1]](bytes)) fail(`${where}: the photo's bytes are not a ${dm[1]} image`);
      if (bytes.length > MAX_PHOTO_BYTES) fail(`${where}: the photo is larger than ${MAX_PHOTO_BYTES / 1024} KB`);
      const name = `${m.id}.${PHOTO_TYPES[dm[1]]}`;
      photoWrites.set(name, bytes);
      keep.add(name);
      src = `/${TEAM_DIR}/${name}`;
    } else if (typeof m.photo === 'string') {
      const pm = m.photo.match(/^\/assets\/img\/team\/([a-z0-9][a-z0-9-]*\.(?:webp|png|jpg))$/);
      if (!pm) fail(`${where}: photo must be a path under /${TEAM_DIR}/ or a data: URL`);
      if (!existsSync(path.join(ROOT, TEAM_DIR, pm[1])) && !photoWrites.has(pm[1])) fail(`${where}: ${m.photo} does not exist`);
      keep.add(pm[1]);
      src = m.photo;
    } else if (m.photo !== null && m.photo !== undefined) {
      fail(`${where}: photo must be a path, a data: URL or null`);
    }
    const who = `<span class="person__who"><b>${escapeText(m.name.trim())}</b>${role.trim() ? `<span>${escapeText(role.trim())}</span>` : ''}</span>`;
    const face = src
      ? `<img class="person__photo" src="${escapeAttr(src)}" width="256" height="256" alt="" loading="lazy">`
      : `<span class="person__mark" aria-hidden="true">${escapeText([...m.name.trim()][0].toUpperCase())}</span>`;
    // The id is kept in the page, so the site editor's build reads the same ids back.
    return `      <li class="person" data-person-id="${m.id}">${face}${who}</li>`;
  });
  const html = read('index.html');
  const rx = /(<ul class="team">\r?\n)[\s\S]*?(\r?\n    <\/ul>)/;
  if (!rx.test(html)) fail('index.html has no <ul class="team"> list');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  write('index.html', html.replace(rx, (all, open, close) => open + items.join(eol) + close));
  // Photos no member uses any more. Only files named as this script names photos; anything else is left alone.
  for (const name of readdirSync(path.join(ROOT, TEAM_DIR))) {
    if (keep.has(name) || !/^[a-z0-9][a-z0-9-]*\.(?:webp|png|jpg)$/.test(name)) continue;
    if (statSync(path.join(ROOT, TEAM_DIR, name)).isFile()) photoWrites.set(name, null);
  }
  report.push(`team ${team.members.length} people`);
}

// ---- write ----
let changed = 0;
for (const [rel, f] of files) {
  if (f.after === undefined || f.after === f.before) continue;
  writeFileSync(path.join(ROOT, rel), f.after, 'utf8');
  changed++;
  console.log('wrote ' + rel);
}
for (const [name, bytes] of photoWrites) {
  const target = path.join(ROOT, TEAM_DIR, name);
  if (bytes === null) {
    unlinkSync(target);
    console.log('deleted ' + TEAM_DIR + '/' + name);
    changed++;
  } else if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
    writeFileSync(target, bytes);
    console.log('wrote ' + TEAM_DIR + '/' + name);
    changed++;
  }
}
console.log(`${report.length} settings applied${report.length ? ': ' + report.join(', ') : ''}. ${changed ? '' : 'No file changed.'}`);
