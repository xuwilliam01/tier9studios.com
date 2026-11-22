// Fills the page with the open roles from the hiring API.
//
// A [data-roles] block holds one child per state, and this script shows exactly one of them:
//   [data-roles-loading]   while the request runs
//   [data-roles-list]      the roles (built here)
//   [data-roles-empty]     no open roles
//   [data-roles-error]     the request failed; a [data-roles-retry] button inside it tries again
// data-roles-limit="5" shows only the first five, and reveals [data-roles-more] when there are more.
//
// Anywhere on the page:
//   [data-roles-paused]  is revealed when roles are listed but applications are paused
//   [data-retention]     receives how long applications are kept, in words

import { getJobs, el, retentionText, factsLine } from './careers.js';

const POSITION_URL = '/careers/position/?p=';

function roleRow(job) {
  return el('li', null, el('a', { class: 'role', href: POSITION_URL + encodeURIComponent(job.slug) },
    el('span', { class: 'role__title' }, job.title),
    el('span', { class: 'role__meta' }, factsLine(job)),
    el('span', { class: 'role__go', 'aria-hidden': 'true' }, 'View role')));
}

function show(block, state) {
  for (const name of ['loading', 'list', 'empty', 'error']) {
    const part = block.querySelector('[data-roles-' + name + ']');
    if (part) part.hidden = name !== state;
  }
  block.dataset.state = state;
}

async function load(blocks) {
  for (const b of blocks) show(b, 'loading');
  const r = await getJobs();
  if (!r.ok || !Array.isArray(r.data.jobs)) {
    for (const b of blocks) show(b, 'error');
    return;
  }
  const jobs = r.data.jobs;
  for (const node of document.querySelectorAll('[data-roles-paused]')) node.hidden = r.data.intakeOpen !== false || !jobs.length;
  for (const node of document.querySelectorAll('[data-retention]')) node.textContent = retentionText(r.data.retentionDays);
  for (const b of blocks) {
    if (!jobs.length) { show(b, 'empty'); continue; }
    const limit = Number(b.dataset.rolesLimit) || jobs.length;
    b.querySelector('[data-roles-list]').replaceChildren(...jobs.slice(0, limit).map(roleRow));
    const more = b.querySelector('[data-roles-more]');
    if (more) more.hidden = jobs.length <= limit;
    show(b, 'list');
  }
}

const blocks = [...document.querySelectorAll('[data-roles]')];
for (const b of blocks) {
  const retry = b.querySelector('[data-roles-retry]');
  if (!retry) continue;
  retry.addEventListener('click', async () => {
    await load(blocks);
    // Loading hid the button, and focus with it. Put focus on what replaced the loading state.
    const shown = b.querySelector('[data-roles-' + b.dataset.state + ']');
    if (shown) { shown.tabIndex = -1; shown.focus(); }
  });
}
if (!blocks.length) {
  // A page without a [data-roles] block may still have [data-retention] (the applicant privacy notice).
  load(blocks);
} else {
  // Ask the hiring API only once a list is near the screen. On the home page the list stays hidden until a
  // visitor enters the main site, so most visits never need it.
  const watch = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    watch.disconnect();
    load(blocks);
  }, { rootMargin: '800px 0px' });
  for (const b of blocks) watch.observe(b);
}
