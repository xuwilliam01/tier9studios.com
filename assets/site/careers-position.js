// One role: its description and the application form. The role is named by ?p=<slug>.
//
// The page's HTML holds every label and message. This script shows one of the page states
// ([data-pos-loading], [data-pos-ready], [data-pos-closed], [data-pos-missing], [data-pos-error]),
// fills in what comes from the hiring API, and runs the form.

import {
  getJob, sendApplication, el, renderBlocks, factsLine, formatBytes, jobPostingData,
  checkApplication, applicationFields, applicationFile, applyFailure, resumeProblem, retentionText,
} from './careers.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const slug = new URLSearchParams(location.search).get('p') || '';
// The server refuses a form sent sooner than this after the page asked for it; a retry waits it out.
const MIN_FORM_AGE_MS = 3500;

let job = null;
let limits = null;
let formToken = '';
let chosenFile = null;
let sending = false;
let saveTimer = 0;

function showState(name) {
  for (const s of ['loading', 'ready', 'closed', 'missing', 'error']) {
    const node = $('[data-pos-' + s + ']');
    if (node) node.hidden = s !== name;
  }
}

// ---- The position ------------------------------------------------------------------------------------

function renderJob(data) {
  job = data.job;
  limits = data.limits || {};
  formToken = data.formToken || '';

  document.title = job.title + ' — Careers at Tier 9 Game Studios';
  const description = $('meta[name="description"]');
  if (description && job.summary) description.setAttribute('content', job.summary);
  const pageUrl = location.origin + location.pathname + '?p=' + encodeURIComponent(job.slug);
  // One page serves every role, so its HTML names no canonical address. The role's own is added here.
  const canonical = document.createElement('link');
  canonical.rel = 'canonical';
  canonical.href = pageUrl;
  document.head.append(canonical);
  // A data block for search engines. It is not executed, so the page's script policy does not apply to it.
  const ld = document.createElement('script');
  ld.type = 'application/ld+json';
  ld.textContent = JSON.stringify(jobPostingData(job, pageUrl));
  document.head.append(ld);

  $('[data-pos-title]').textContent = job.title;
  $('[data-pos-title-short]').textContent = job.title;
  $('[data-pos-meta]').replaceChildren(...factsLine(job));
  const summary = $('[data-pos-summary]');
  summary.textContent = job.summary || '';
  summary.hidden = !job.summary;
  $('[data-pos-body]').replaceChildren(renderBlocks(job.blocks));

  const paused = data.intakeOpen === false;
  $('[data-apply-paused]').hidden = !paused;
  $('[data-apply-form]').hidden = paused;
  for (const jump of $$('[data-apply-jump]')) jump.hidden = paused;
  if (!paused) setUpForm(data);
  showState('ready');
}

async function load() {
  showState('loading');
  const suffix = ' — Careers at Tier 9 Game Studios';
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) {
    document.title = 'Role not found' + suffix;
    showState('missing');
    return;
  }
  const r = await getJob(slug);
  if (r.ok && r.data.job) { renderJob(r.data); return; }
  if (r.status === 410) {
    const title = $('[data-pos-closed-title]');
    if (title && r.data.title) title.textContent = r.data.title;
    document.title = 'Role closed' + suffix;
    showState('closed');
  } else if (r.status === 404) {
    document.title = 'Role not found' + suffix;
    showState('missing');
  } else {
    document.title = 'Role did not load' + suffix;
    showState('error');
  }
}

// ---- The form ------------------------------------------------------------------------------------------

const draftKey = () => 't9.apply.' + slug;

function readForm() {
  const form = $('[data-apply-form]');
  const answers = {};
  for (const q of job.questions || []) {
    if (q.kind === 'yesno') {
      const picked = $('input[name="answer-' + q.id + '"]:checked', form);
      answers[q.id] = picked ? picked.value : '';
    } else {
      answers[q.id] = $('#f-answer-' + q.id, form).value;
    }
  }
  return {
    name: $('#f-name', form).value,
    email: $('#f-email', form).value,
    phone: $('#f-phone', form).value,
    location: $('#f-location', form).value,
    links: [0, 1, 2].map((i) => $('#f-link' + i, form).value),
    message: $('#f-message', form).value,
    answers,
    consent: $('#f-consent', form).checked,
    file: chosenFile,
    website: $('input[name="t9_hp"]', form).value,
  };
}

// What was typed is kept for this browser tab only, so a reload does not lose it. The file is not kept.
function saveDraft() {
  const v = readForm();
  try {
    sessionStorage.setItem(draftKey(), JSON.stringify({
      name: v.name, email: v.email, phone: v.phone, location: v.location,
      links: v.links, message: v.message, answers: v.answers,
    }));
  } catch { /* storage refused: the form still works */ }
}
function restoreDraft() {
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem(draftKey())); } catch { /* nothing usable saved */ }
  if (!d || typeof d !== 'object') return;
  const form = $('[data-apply-form]');
  const set = (id, value) => { const node = $(id, form); if (node && typeof value === 'string') node.value = value; };
  set('#f-name', d.name); set('#f-email', d.email); set('#f-phone', d.phone); set('#f-location', d.location); set('#f-message', d.message);
  (Array.isArray(d.links) ? d.links : []).forEach((url, i) => set('#f-link' + i, url));
  // A link field that holds something from last time has to be on screen.
  for (const extra of $$('[data-extra-link]', form)) if ($('input', extra).value) extra.hidden = false;
  syncAddLink();
  for (const q of job.questions || []) {
    const a = d.answers && d.answers[q.id];
    if (typeof a !== 'string') continue;
    if (q.kind === 'yesno') {
      const radio = $$('input[name="answer-' + q.id + '"]', form).find((r) => r.value === a);
      if (radio) radio.checked = true;
    } else set('#f-answer-' + q.id, a);
  }
}
function clearDraft() {
  try { sessionStorage.removeItem(draftKey()); } catch { /* nothing to clear */ }
}

// "Add another link" shows the next hidden link field, and goes away once both are on screen.
function syncAddLink() {
  $('[data-add-link]').closest('p').hidden = !$('[data-extra-link][hidden]');
}
function addLink() {
  const next = $('[data-extra-link][hidden]');
  if (!next) return;
  next.hidden = false;
  syncAddLink();
  $('input', next).focus();
}

function questionField(q) {
  const key = 'answer-' + q.id;
  const errorId = 'e-' + key;
  const label = [q.label, q.required ? null : el('span', { class: 'field-optional' }, ' (optional)')];
  const error = el('p', { class: 'field-error', id: errorId, 'data-error-for': key, hidden: true });
  if (q.kind === 'yesno') {
    // A radio group can be marked required and invalid as a whole, and can carry the error as its description.
    return el('fieldset', {
      class: 'field field-choice', 'data-field': key, role: 'radiogroup',
      'aria-required': q.required ? 'true' : null, 'aria-describedby': errorId,
    },
      el('legend', { class: 'field-label' }, label),
      el('div', { class: 'choices' }, ['yes', 'no'].map((value) =>
        el('label', { class: 'choice' },
          el('input', { type: 'radio', name: key, value, id: 'f-' + key + '-' + value }),
          el('span', null, value === 'yes' ? 'Yes' : 'No')))),
      error);
  }
  const id = 'f-' + key;
  const input = q.kind === 'long'
    ? el('textarea', { id, rows: '5', maxlength: String((limits && limits.answer) || 2000), required: q.required, 'aria-describedby': errorId })
    : el('input', {
      id, type: q.kind === 'url' ? 'url' : 'text', maxlength: q.kind === 'url' ? '300' : '400',
      inputmode: q.kind === 'url' ? 'url' : null, autocapitalize: q.kind === 'url' ? 'none' : null,
      placeholder: q.kind === 'url' ? 'https://' : null, required: q.required, 'aria-describedby': errorId,
    });
  return el('div', { class: 'field', 'data-field': key }, el('label', { class: 'field-label', for: id }, label), input, error);
}

function setError(key, message) {
  const form = $('[data-apply-form]');
  const slot = $('[data-error-for="' + key + '"]', form);
  if (slot) { slot.textContent = message || ''; slot.hidden = !message; }
  const wrap = $('[data-field="' + key + '"]', form);
  if (wrap) wrap.classList.toggle('has-error', !!message);
  const control = wrap && (wrap.matches('fieldset') ? wrap : $('input, textarea', wrap));
  if (control) { if (message) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid'); }
  // The list at the top of the form drops the line for a problem that has been dealt with.
  if (!message) {
    const box = $('[data-apply-errors]', form);
    const line = $('[data-summary-for="' + key + '"]', box);
    if (line) line.remove();
    if (!$('li', box)) box.hidden = true;
  }
}

// `errors` maps a field to its message. The key "form" is a problem with no field: the send itself failed.
function showErrors(errors) {
  const form = $('[data-apply-form]');
  const box = $('[data-apply-errors]', form);
  $('ul', box).replaceChildren();
  for (const slot of $$('[data-error-for]', form)) setError(slot.dataset.errorFor, errors[slot.dataset.errorFor] || '');
  const keys = Object.keys(errors);
  box.hidden = !keys.length;
  if (!keys.length) return;
  $('[data-apply-errors-title]', box).textContent = errors.form ? 'Your application has not been sent.' : 'Please check the form.';
  $('ul', box).replaceChildren(...keys.map((key) => {
    const wrap = $('[data-field="' + key + '"]', form);
    // Away from the field, a message has to say which field or question it means.
    const question = (job.questions || []).find((q) => 'answer-' + q.id === key);
    const text = question ? '“' + question.label + '”: ' + errors[key] : errors[key];
    // Once a resume is chosen its file input is hidden, and the control left to act on is Remove.
    const target = wrap && (key === 'resume' && chosenFile ? $('[data-resume-clear]', wrap) : $('input, textarea', wrap));
    if (!target || !target.id) return el('li', { 'data-summary-for': key }, text);
    const link = el('a', { href: '#' + target.id }, text);
    // Take the person to the field itself, ready to type.
    link.addEventListener('click', (e) => {
      e.preventDefault();
      target.scrollIntoView({ block: 'center' });
      target.focus({ preventScroll: true });
    });
    return el('li', { 'data-summary-for': key }, link);
  }));
  box.scrollIntoView({ block: 'center' });
  box.focus({ preventScroll: true });
}

function setFile(file) {
  const form = $('[data-apply-form]');
  chosenFile = file || null;
  const problem = resumeProblem(chosenFile, limits);
  $('[data-resume-chosen]', form).hidden = !chosenFile;
  $('[data-resume-drop]', form).hidden = !!chosenFile;
  if (chosenFile) {
    $('[data-resume-name]', form).textContent = chosenFile.name;
    $('[data-resume-size]', form).textContent = formatBytes(chosenFile.size);
  } else {
    $('#f-resume', form).value = '';
  }
  setError('resume', problem || '');
}

function setStatus(text) {
  $('[data-apply-status]').textContent = text || '';
}

function setSending(on) {
  sending = on;
  const button = $('[data-apply-submit]');
  button.disabled = on;
}

async function submit(event) {
  event.preventDefault();
  if (sending) return;
  const values = readForm();
  const errors = checkApplication(values, job, limits);
  showErrors(errors);
  if (Object.keys(errors).length) { setStatus(''); return; }

  setSending(true);
  setStatus(chosenFile ? 'Sending your application and resume…' : 'Sending your application…');
  let result;
  try {
    const file = applicationFile(values, job);
    result = await sendApplication(slug, applicationFields(values, job, formToken), file);
    if (!result.ok && result.data.error === 'form_expired') {
      // The page sat open past the form's lifetime. Ask for a fresh one, wait out its minimum age, send once more.
      const fresh = await getJob(slug);
      if (fresh.ok && fresh.data.formToken) {
        formToken = fresh.data.formToken;
        await new Promise((r) => setTimeout(r, MIN_FORM_AGE_MS));
        result = await sendApplication(slug, applicationFields(values, job, formToken), file);
      }
    }
  } catch {
    result = { ok: false, status: 0, data: {} };
  }
  setSending(false);

  if (result.ok && result.data.ok) {
    // A save still waiting from the last keystroke must not write the draft back after it is cleared.
    clearTimeout(saveTimer);
    clearDraft();
    const form = $('[data-apply-form]');
    form.hidden = true;
    form.reset();
    chosenFile = null;
    $('[data-apply-title]').hidden = true;
    for (const jump of $$('[data-apply-jump]')) jump.hidden = true;
    $('[data-apply-bar]').hidden = true;
    $('[data-apply-ref]').textContent = result.data.ref || '';
    $('[data-apply-email]').textContent = values.email.trim();
    const done = $('[data-apply-done]');
    done.hidden = false;
    done.scrollIntoView({ block: 'center' });
    done.focus({ preventScroll: true });
    setStatus('');
    return;
  }

  const failure = applyFailure(result, Boolean(chosenFile));
  setStatus('');
  let key = failure.field || null;
  if (key && key.startsWith('links')) key = 'link' + (Number((key.match(/\d+/) || [0])[0]) || 0);
  else if (key && key.startsWith('answers')) key = 'answer-' + key.slice(key.lastIndexOf('.') + 1);
  const known = key && $('[data-error-for="' + key + '"]');
  showErrors(known ? { [key]: failure.message } : { form: failure.message });
}

function setUpForm(data) {
  const form = $('[data-apply-form]');

  // Resume: required, optional, or not asked for.
  const resume = $('[data-field="resume"]', form);
  resume.hidden = job.resumeMode === 'hidden';
  const optional = $('[data-resume-optional]', form);
  if (optional) optional.hidden = job.resumeMode !== 'optional';
  const types = limits.resumeTypes || [];
  $('#f-resume', form).setAttribute('accept', types.map((t) => '.' + t.ext).join(','));
  $('[data-resume-hint]', form).textContent = [types.map((t) => t.label).join(' or '), limits.resumeBytes ? 'up to ' + formatBytes(limits.resumeBytes) : ''].filter(Boolean).join(', ');

  $('[data-questions]', form).replaceChildren(...(job.questions || []).map(questionField));

  for (const node of $$('[data-retention]')) node.textContent = retentionText(data.retentionDays);

  restoreDraft();

  form.addEventListener('input', (e) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 400);
    const wrap = e.target.closest('[data-field]');
    if (wrap && wrap.classList.contains('has-error')) setError(wrap.dataset.field, '');
  });
  form.addEventListener('submit', submit);
  $('[data-add-link]', form).addEventListener('click', addLink);

  const input = $('#f-resume', form);
  input.addEventListener('change', () => {
    setFile(input.files && input.files[0]);
    // Choosing a file hides the input that had focus. Remove is the control that takes its place.
    if (chosenFile) $('[data-resume-clear]', form).focus();
  });
  $('[data-resume-clear]', form).addEventListener('click', () => { setFile(null); input.focus(); });
  const drop = $('[data-resume-drop]', form);
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('is-over'); });
  }
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) setFile(file);
  });

  // On a phone, a bar with the Apply link stays on screen until the form itself is in view.
  const bar = $('[data-apply-bar]');
  if ('IntersectionObserver' in window) {
    bar.hidden = false;
    new IntersectionObserver((entries) => {
      bar.classList.toggle('is-away', entries[entries.length - 1].isIntersecting);
    }).observe($('[data-apply]'));
  }
}

const share = $('[data-pos-share]');
if (share) {
  share.addEventListener('click', async () => {
    const label = share.querySelector('[data-pos-share-label]') || share;
    const original = label.textContent;
    try {
      await navigator.clipboard.writeText(location.href);
      label.textContent = 'Link copied';
    } catch {
      label.textContent = 'Copy the address from your browser';
    }
    setTimeout(() => { label.textContent = original; }, 2400);
  });
}
const retry = $('[data-pos-retry]');
if (retry) {
  retry.addEventListener('click', async () => {
    await load();
    // Loading hid the button, and focus with it. Put focus on the heading of the state that replaced it.
    const heading = $('main > :not([hidden]) h1');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  });
}

load();
