// Feedback, product updates and anonymous usage counts, sent to the Rembrandt API (CONFIG.apiUrl;
// see rembrandt-cloud/api). A build without an API address keeps all of it off.
//
// Usage counts are opt-in: Rembrandt asks once, and Settings › Data & privacy can turn them on or off
// at any time. They are tallies only ("crop used 3 times today", app version, operating system),
// tied to a random install id that can be reset, sent at most every ten minutes. Never photos, file
// names, edits, places, or anything about the person.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el } from './util.js';
import { button, segmented } from './ui.js';
import { icon } from './icons.js';
import { CONFIG } from './config.js';
import { prefs, savePrefs } from './account.js';
import { isTauri, isIOS, isAndroid } from './platform.js';

const api = () => (CONFIG.apiUrl || '').replace(/\/$/, '');
export const apiAvailable = () => !!api();

async function post(path, body) {
  const r = await fetch(`${api()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `The server answered ${r.status}`);
  return j;
}

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/i;

// Product updates: one email address, kept until the person unsubscribes (every email links to it).
export async function subscribeUpdates(email, source = 'app') {
  await post('/subscribe', { email: email.trim(), source });
  prefs.updatesEmail = email.trim();
  savePrefs();
}

const os = () => (isIOS ? 'ios' : isAndroid ? 'android' : /Mac/.test(navigator.platform) ? 'mac' : /Win/.test(navigator.platform) ? 'windows' : /Linux/.test(navigator.platform) ? 'linux' : 'other');
const platformName = () => `${os()}-${isTauri ? 'app' : 'web'}`;
const version = () => window.LUMEN_BUILD?.version || 'dev';

// What "Include system details" sends with feedback.
function details(app) {
  let gpu = '';
  try { const gl = app.engine?.gl; gpu = gl ? gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) : ''; } catch { /* none */ }
  return { version: version(), platform: platformName(), gpu: String(gpu).slice(0, 120), cores: navigator.hardwareConcurrency || 0, memory: navigator.deviceMemory || 0, screen: `${screen.width}x${screen.height}@${devicePixelRatio}` };
}

// ------------------------------------------------------------------ Send feedback

export function openFeedback(app, { kind = 'idea' } = {}) {
  const dlg = el('dialog', { class: 'dlg feedback-dlg' });
  const done = () => { dlg.close(); dlg.remove(); };
  let k = kind;
  const kinds = segmented([{ value: 'idea', label: 'Idea' }, { value: 'problem', label: 'Problem' }, { value: 'praise', label: 'Something I like' }], k, (v) => { k = v; text.placeholder = PH[v]; });
  const PH = {
    idea: 'What would make Rembrandt better for you?',
    problem: 'What happened, and what did you expect? Which photo type (RAW camera, JPEG…) if it matters.',
    praise: 'What works well for you?',
  };
  const text = el('textarea', { class: 'text-input feedback-text', rows: 6, maxlength: 8000, placeholder: PH[k], 'aria-label': 'Your message' });
  const email = el('input', { class: 'text-input', type: 'email', value: prefs.updatesEmail || '', placeholder: 'you@example.com (optional, to reply)', autocomplete: 'email', 'aria-label': 'Your email' });
  const updates = el('input', { type: 'checkbox', checked: !prefs.updatesEmail });
  const withDetails = el('input', { type: 'checkbox', checked: true });
  const note = el('p', { class: 'hint feedback-note', 'aria-live': 'polite' });
  for (const i of [text, email]) i.addEventListener('keydown', (e) => e.stopPropagation());
  const fallback = () => `https://github.com/${CONFIG.repo}/issues/new?title=${encodeURIComponent(k === 'problem' ? 'Problem: ' : 'Idea: ')}&body=${encodeURIComponent(text.value + '\n\n' + (withDetails.checked ? '```\n' + JSON.stringify(details(app), null, 1) + '\n```' : ''))}`;
  const send = button('Send', async () => {
    const msg = text.value.trim();
    if (!msg) { note.textContent = 'Write a few words first.'; text.focus(); return; }
    const mail = email.value.trim();
    if (mail && !EMAIL_RE.test(mail)) { note.textContent = 'That email address doesn’t look right. Leave it empty to send without one.'; email.focus(); return; }
    send.disabled = true; note.textContent = 'Sending…';
    try {
      await post('/feedback', { kind: k, message: msg, email: mail || undefined, updates: !!(mail && updates.checked), app: withDetails.checked ? details(app) : undefined });
      if (mail && updates.checked) { prefs.updatesEmail = mail; savePrefs(); }
      done();
      app.toast(mail ? 'Thanks. Your feedback was sent, and we can reply by email.' : 'Thanks. Your feedback was sent.');
    } catch (e) {
      send.disabled = false;
      note.replaceChildren(`Couldn’t send it (${e.message}). `, el('a', { href: fallback(), target: '_blank', rel: 'noopener' }, 'Post it on GitHub instead'), '.');
    }
  }, 'primary', 'send');
  dlg.append(
    el('div', { class: 'dlg-head row between' }, el('h2', {}, 'Send feedback'), el('button', { class: 'icon-btn dlg-x', 'aria-label': 'Close', onclick: done }, icon('x'))),
    el('div', { class: 'dlg-body feedback-body' },
      el('p', { class: 'lead' }, 'Read by the person who makes Rembrandt. Photos are never attached.'),
      kinds.el, text,
      el('div', { class: 'field' }, el('span', {}, 'Email'), email),
      el('label', { class: 'check-row' }, updates, el('span', {}, 'Also email me about new versions (a few times a year)')),
      el('label', { class: 'check-row' }, withDetails, el('span', {}, 'Include system details: app version, operating system, graphics card')),
      note),
    el('div', { class: 'dlg-foot' }, button('Cancel', done, 'ghost'), send));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(); });
  document.body.append(dlg);
  dlg.showModal();
  if (!apiAvailable()) note.replaceChildren('This copy of Rembrandt has no feedback address. ', el('a', { href: fallback(), target: '_blank', rel: 'noopener' }, 'Post it on GitHub'), ' instead.');
  text.focus();
}

// ------------------------------------------------------------------ Product updates (Settings)

export function updatesCard(card, app) {
  const email = el('input', { class: 'text-input', type: 'email', value: prefs.updatesEmail || '', placeholder: 'you@example.com', autocomplete: 'email', 'aria-label': 'Email for product updates' });
  email.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go.click(); });
  const note = el('p', { class: 'hint', 'aria-live': 'polite' }, prefs.updatesEmail ? `Updates go to ${prefs.updatesEmail}. Every email has an unsubscribe link.` : 'New versions and the occasional request for feedback, a few times a year. Unsubscribe from any email.');
  const go = button(prefs.updatesEmail ? 'Update' : 'Sign up', async () => {
    const v = email.value.trim();
    if (!EMAIL_RE.test(v)) { note.textContent = 'That doesn’t look like an email address.'; return; }
    go.disabled = true;
    try { await subscribeUpdates(v, 'app'); note.textContent = `Thanks. Updates will go to ${v}.`; go.lastChild.textContent = 'Update'; }
    catch (e) { note.textContent = `Couldn’t sign up: ${e.message}`; }
    finally { go.disabled = false; }
  }, 'sm primary');
  return card('Product updates', el('div', { class: 'row updates-row' }, email, go), note,
    el('div', { class: 'row-btns' }, button('Send feedback…', () => openFeedback(app), 'sm ghost', 'send')));
}

// ------------------------------------------------------------------ Usage counts (opt-in)

const counts = new Map();
let timer = 0, last = 0;
const FLUSH_MS = 10 * 60e3;
export const usageOn = () => prefs.usageStats === true && apiAvailable();

function installId() {
  if (!/^[a-f0-9]{32}$/.test(prefs.installId || '')) { prefs.installId = crypto.randomUUID().replace(/-/g, ''); savePrefs(); }
  return prefs.installId;
}
export function resetInstallId() { prefs.installId = ''; savePrefs(); }

// Counts one use: track('tool', 'crop'), track('export', 'jpeg'), track('feature', 'hdr-one').
export function track(event, value = '') {
  if (!usageOn()) return;
  const key = value ? `${event}:${String(value).toLowerCase().replace(/[^a-z0-9_.:+-]/g, '').slice(0, 48)}` : event;
  counts.set(key, (counts.get(key) || 0) + 1);
  if (!timer) timer = setTimeout(flushUsage, Math.max(5000, FLUSH_MS - (Date.now() - last)));
}

export function flushUsage({ beacon = false } = {}) {
  clearTimeout(timer); timer = 0;
  if (!usageOn() || !counts.size) return;
  const body = JSON.stringify({ install: installId(), version: version(), platform: platformName(), events: Object.fromEntries(counts) });
  counts.clear(); last = Date.now();
  const url = `${api()}/usage`;
  if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
  else fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

export function setUsage(on) {
  prefs.usageStats = on; savePrefs();
  if (!on) counts.clear();
}

// Asks once, a while after Rembrandt has been in use, in a small card that doesn't block anything.
export function askAboutUsage(app) {
  if (!apiAvailable() || prefs.usageStats !== undefined || prefs.usageAsked) return;
  const card = el('div', { class: 'usage-ask', role: 'dialog', 'aria-label': 'Help improve Rembrandt' },
    el('b', {}, 'Help improve Rembrandt?'),
    el('p', {}, 'Share anonymous counts of which tools get used, with the app version and operating system. Never photos, file names or anything about you. You can change this in Settings › Data & privacy.'),
    el('div', { class: 'row-btns' },
      button('Share counts', () => { setUsage(true); close(); track('app_open'); app.toast('Thanks. Usage counts are on.'); }, 'sm primary'),
      button('No thanks', () => { setUsage(false); close(); }, 'sm ghost')));
  const close = () => { prefs.usageAsked = true; savePrefs(); card.remove(); };
  document.body.append(card);
}

if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushUsage({ beacon: true }); });
  window.addEventListener('pagehide', () => flushUsage({ beacon: true }));
}
