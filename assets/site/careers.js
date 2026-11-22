// What the careers pages share: the hiring API client, the rules the application form checks before it
// sends, and helpers that build page content from API data.
//
// The API lives on the team site. Each careers page names it in <meta name="t9-api"> and allows that one
// origin in its Content-Security-Policy. Everything that comes back is treated as text: it reaches the
// page through text nodes and checked attributes only, never through HTML strings.

const apiMeta = document.querySelector('meta[name="t9-api"]');
export const API_BASE = ((apiMeta && apiMeta.content) || '').replace(/\/+$/, '');

export const WORKPLACE_LABEL = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote' };
export const EMPLOYMENT_LABEL = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', internship: 'Internship' };
// schema.org values for the job posting data that search engines read.
const EMPLOYMENT_SCHEMA = { full_time: 'FULL_TIME', part_time: 'PART_TIME', contract: 'CONTRACTOR', internship: 'INTERN' };

// Field lengths the server enforces (the team site's hiring-model.js LIMITS). The form uses them for
// maxlength and for messages; the server remains the authority.
export const FIELD_MAX = { name: 120, email: 254, phone: 40, location: 120, linkUrl: 300, message: 5000, answer: 2000 };

// ---- API ---------------------------------------------------------------------------------------------

// One request. Resolves to { ok, status, data } and never rejects: a network failure or a timeout is
// status 0. Cookies are never sent. `body`, when given, is sent as it is, with `contentType`.
async function call(path, { method = 'GET', body = null, contentType = null, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: body ? { 'Content-Type': contentType } : undefined,
      body: body || undefined,
      signal: ctl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { /* an error page without a JSON body */ }
    return { ok: res.ok, status: res.status, data: data && typeof data === 'object' ? data : {} };
  } catch {
    return { ok: false, status: 0, data: {} };
  } finally {
    clearTimeout(timer);
  }
}

export const getJobs = () => call('/api/public/hiring/jobs');
export const getJob = (slug) => call('/api/public/hiring/jobs/' + encodeURIComponent(slug));

// An application is one binary body: four bytes giving the length of the fields (big-endian), the fields
// as JSON, then the resume file's own bytes, if there is one. The file is sent as it is, never re-encoded.
export function sendApplication(slug, fields, file) {
  const json = new TextEncoder().encode(JSON.stringify(fields));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.length);
  const body = new Blob(file ? [length, json, file] : [length, json]);
  return call('/api/public/hiring/jobs/' + encodeURIComponent(slug) + '/apply', {
    method: 'POST', body, contentType: 'application/octet-stream', timeoutMs: 120000,
  });
}

// ---- DOM helpers ---------------------------------------------------------------------------------------

// el('a', { class: 'x', href: '/y' }, 'text', childNode). Strings become text nodes. Attributes with a
// null, undefined or false value are left out; true writes the bare attribute.
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// A link target from API data is used only when it is plainly a web or mail address.
export function safeHref(value) {
  const s = String(value || '').trim();
  return /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(s) ? s : null;
}

function renderRuns(runs) {
  const out = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    let node = document.createTextNode(String(run.text ?? ''));
    if (run.i) node = el('em', null, node);
    if (run.b) node = el('strong', null, node);
    const href = run.href ? safeHref(run.href) : null;
    if (href) {
      node = el('a', href.toLowerCase().startsWith('mailto:') ? { href } : { href, target: '_blank', rel: 'noopener noreferrer' }, node);
    }
    out.push(node);
  }
  return out;
}

// A position description arrives as a list of blocks (headings, paragraphs, lists, rules). Description
// headings sit under the page's own <h2>, so level 2 becomes <h3> and level 3 becomes <h4>.
export function renderBlocks(blocks) {
  const frag = document.createDocumentFragment();
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b.t === 'h') frag.append(el(b.level === 3 ? 'h4' : 'h3', null, renderRuns(b.runs)));
    else if (b.t === 'p') frag.append(el('p', null, renderRuns(b.runs)));
    else if (b.t === 'ul' || b.t === 'ol') frag.append(el(b.t, null, (b.items || []).map((runs) => el('li', null, renderRuns(runs)))));
    else if (b.t === 'hr') frag.append(el('hr'));
  }
  return frag;
}

// The plain text of a block list, for the job posting data.
export function blocksToText(blocks) {
  const line = (runs) => (Array.isArray(runs) ? runs : []).map((r) => String(r.text ?? '')).join('');
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b.t === 'h' || b.t === 'p') out.push(line(b.runs));
    else if (b.t === 'ul' || b.t === 'ol') for (const item of b.items || []) out.push('- ' + line(item));
  }
  return out.join('\n');
}

export function metaLine(job) {
  return [job.location, WORKPLACE_LABEL[job.workplace], EMPLOYMENT_LABEL[job.employment]].filter(Boolean);
}

// The line of facts under a role's title, on the list and on the role's own page: department, place,
// workplace, hours and pay, with a dot between them. Each fact is its own inline block (.fact-item), so the
// line wraps between facts and never inside one.
export function factsLine(job) {
  const facts = [job.department, ...metaLine(job), job.salary].filter(Boolean);
  const out = [];
  facts.forEach((fact, i) => {
    if (i) out.push(' ');
    out.push(el('span', { class: 'fact-item' }, i < facts.length - 1 ? fact + ' ·' : fact));
  });
  return out;
}

// A time from the API (an ISO string, or milliseconds) as a Date, or null.
function toDate(value) {
  if (value == null || value === '') return null;
  const d = new Date(typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

// How long applications are kept, in words: 365 days is "12 months".
export function retentionText(days) {
  const d = Number(days) || 365;
  if (d % 365 === 0) return d === 365 ? '12 months' : d / 365 + ' years';
  return d + ' days';
}

export function formatBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1).replace(/\.0$/, '') + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

// Job posting data in the schema.org shape search engines read. It describes the page it is added to.
export function jobPostingData(job, pageUrl) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: blocksToText(job.blocks) || job.summary || job.title,
    datePosted: toDate(job.publishedAt) ? toDate(job.publishedAt).toISOString().slice(0, 10) : undefined,
    employmentType: EMPLOYMENT_SCHEMA[job.employment],
    hiringOrganization: { '@type': 'Organization', name: 'Tier 9 Game Studios', sameAs: 'https://www.tier9studios.com/' },
    directApply: true,
    url: pageUrl,
  };
  if (job.location) data.jobLocation = { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: job.location } };
  if (job.workplace === 'remote') data.jobLocationType = 'TELECOMMUTE';
  return data;
}

// ---- The application form's rules ----------------------------------------------------------------------

// The same rule the server applies: an ordinary mailbox name, then a host name made of plain labels. It
// leaves out anything that would mean something in a link, such as "?" or "%" after the "@".
const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_DOMAIN = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export function isEmailAddress(value) {
  const s = String(value);
  const at = s.lastIndexOf('@');
  if (at < 1 || s.length > FIELD_MAX.email) return false;
  const local = s.slice(0, at);
  return local.length <= 64 && EMAIL_LOCAL.test(local) && EMAIL_DOMAIN.test(s.slice(at + 1));
}

// The server refuses an address with a space anywhere in it, which the URL parser alone lets through.
export function isWebAddress(value) {
  const s = String(value).trim();
  if (/\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
  } catch {
    return false;
  }
}

// People type "linkedin.com/in/me". Give it a scheme so it passes as the address they meant.
export function normalizeWebAddress(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s;
}

export function resumeProblem(file, limits) {
  if (!file) return null;
  const types = (limits && limits.resumeTypes) || [];
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const labels = types.map((t) => t.label).join(' or ');
  if (types.length && !types.some((t) => t.ext === ext)) return 'Please attach a ' + labels + ' file.';
  if (file.size === 0) return 'That file is empty.';
  if (limits && limits.resumeBytes && file.size > limits.resumeBytes) return 'That file is larger than ' + formatBytes(limits.resumeBytes) + '.';
  return null;
}

// values: { name, email, phone, location, links: [address, ...], message, answers: { id: value }, consent, file }
// Returns { field: message } for every problem; an empty object means the form may be sent.
export function checkApplication(values, job, limits) {
  const errors = {};
  const name = values.name.trim();
  const email = values.email.trim();
  if (!name) errors.name = 'Enter your name.';
  else if (name.length > FIELD_MAX.name) errors.name = 'Please shorten your name.';
  if (!email) errors.email = 'Enter your email address.';
  else if (!isEmailAddress(email)) errors.email = 'That email address does not look right.';
  if (values.phone.trim().length > FIELD_MAX.phone) errors.phone = 'Please shorten the phone number.';

  if (job.resumeMode !== 'hidden') {
    if (!values.file && job.resumeMode === 'required') errors.resume = 'Attach your resume.';
    else {
      const problem = resumeProblem(values.file, limits);
      if (problem) errors.resume = problem;
    }
  }

  // An address is checked as it will be sent: "https://" is added to one typed without it.
  values.links.forEach((link, i) => {
    const address = normalizeWebAddress(link);
    if (!address) return;
    if (address.length > FIELD_MAX.linkUrl || !isWebAddress(address)) errors['link' + i] = 'Enter a full web address, like https://example.com.';
  });

  const maxMessage = (limits && limits.message) || FIELD_MAX.message;
  if (values.message.length > maxMessage) errors.message = 'Please keep this under ' + maxMessage.toLocaleString('en-CA') + ' characters.';

  const maxAnswer = (limits && limits.answer) || FIELD_MAX.answer;
  for (const q of job.questions || []) {
    const a = String(values.answers[q.id] ?? '').trim();
    if (!a) {
      if (q.required) errors['answer-' + q.id] = q.kind === 'yesno' ? 'Choose yes or no.' : 'Please answer this question.';
      continue;
    }
    const sent = q.kind === 'url' ? normalizeWebAddress(a) : a;
    if (sent.length > maxAnswer) errors['answer-' + q.id] = 'Please keep this under ' + maxAnswer.toLocaleString('en-CA') + ' characters.';
    else if (q.kind === 'url' && !isWebAddress(sent)) errors['answer-' + q.id] = 'Enter a full web address, like https://example.com.';
  }

  if (!values.consent) errors.consent = 'Tick the box to agree to the applicant privacy notice.';
  return errors;
}

// The file to send with an application: the chosen resume, unless the position does not ask for one.
export const applicationFile = (values, job) => (values.file && job.resumeMode !== 'hidden' ? values.file : null);

// The fields of an application, from checked form values. The resume's bytes travel beside them.
export function applicationFields(values, job, formToken) {
  const answers = {};
  for (const q of job.questions || []) {
    const a = String(values.answers[q.id] ?? '').trim();
    if (a) answers[q.id] = q.kind === 'url' ? normalizeWebAddress(a) : a;
  }
  const file = applicationFile(values, job);
  return {
    name: values.name.trim(),
    email: values.email.trim(),
    phone: values.phone.trim(),
    location: values.location.trim(),
    // Every row goes, the empty ones too (the server skips them), so the row a refusal names is the form's own.
    links: values.links.map((link) => ({ url: normalizeWebAddress(link) })),
    message: values.message.trim(),
    answers,
    consent: true,
    formToken,
    // Left empty by people. A filled value marks an automated submission.
    website: values.website || '',
    ...(file ? { resume: { name: file.name } } : {}),
  };
}

// What to tell the applicant when the apply route refuses. `field` names the form field to mark, if any.
// The server stops reading an application after a minute. A large resume on a slow connection can take
// longer, and that reaches this page as a failed request, the same as no connection at all.
export function applyFailure(result, sentFile) {
  const code = result.data && result.data.error;
  if (result.status === 0 && sentFile) return { message: 'The upload did not finish. Check your connection and try again, or attach a smaller file. Nothing you typed has been lost.' };
  if (result.status === 0) return { message: 'We could not reach our server. Check your connection and try again. Nothing you typed has been lost.' };
  if (result.status === 429) return { message: 'You have sent several applications in a short time. Please wait a while and try again.' };
  if (code === 'resume_too_large' || result.status === 413) return { field: 'resume', message: 'That file is too large for us to accept.' };
  if (code === 'closed') return { message: 'This position has just closed and is no longer taking applications.' };
  if (code === 'not_found') return { message: 'This position is no longer listed.' };
  if (code === 'intake_paused' || code === 'busy' || result.status === 503) return { message: 'We cannot take applications right this minute. Please try again shortly. Nothing you typed has been lost.' };
  if (code === 'form_expired') return { message: 'This page has been open too long to send from. Reload it and send again. What you typed is kept.' };
  if (code === 'invalid') return { field: result.data.field || null, message: result.data.message || 'Something in the form was not accepted. Please check it and try again.' };
  return { message: 'Something went wrong on our side. Please try again in a minute. Nothing you typed has been lost.' };
}
