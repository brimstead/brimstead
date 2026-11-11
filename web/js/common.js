// Shared chrome for every page: nav lockup, footer, $BRIM CA slot with copy button, live countdown to launch.
// Then starts the shared motion layer (motion.js).
import { CONFIG } from '/config.js';
import { initMotion } from '/js/motion.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const launchMs = Date.parse(CONFIG.launchAt);
export const hasCa = () => /^0x[0-9a-fA-F]{40}$/.test(CONFIG.ca || '');
export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
export const explorerAddr = (a) => `${CONFIG.explorer}/address/${a}`;
export const explorerTx = (h) => `${CONFIG.explorer}/tx/${h}`;

export function launchLabel() {
  const d = new Date(launchMs);
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${mon} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** The logo mark (same geometry as /img/logo.svg) with an outline path for the DrawSVG intro and a morphable drop. */
export const markSVG = (cls = '') => `<svg class="mark ${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <path class="mark-fill" fill="#13161D" d="M8 20.5h44V28c0 12-9.6 19.5-22 19.5S8 40 8 28z"/>
  <path class="mark-fill" fill="#2340D8" d="M8 20.5h44V26c0 7.4-9.7 11.6-22 11.6S8 33.4 8 26z"/>
  <rect class="mark-fill" fill="#13161D" x="22" y="45" width="16" height="10" rx="1.5"/>
  <path class="mark-fill" fill="#FF5B1F" d="M5 15.5h47a6 6 0 0 1 6 6v2.5h-4.5v-2.5a1.5 1.5 0 0 0-1.5-1.5H5z"/>
  <path class="mark-drop" fill="#FF5B1F" d="M55.75 24.5s4 4.9 4 7.6a4 4 0 0 1-8 0c0-2.7 4-7.6 4-7.6z"/>
  <path class="mark-outline" fill="none" stroke="#FF5B1F" stroke-width="2" stroke-linejoin="round" d="M8 20.5h44V28c0 12-9.6 19.5-22 19.5S8 40 8 28zM5 15.5h47a6 6 0 0 1 6 6v2.5"/>
</svg>`;

const wordmark = (cls = '') =>
  `<a class="wordmark ${cls}" href="/" aria-label="Brimstead home">${markSVG()}<span class="wm">Brimstead<span class="dot">.</span></span></a>`;

function renderNav() {
  const el = $('#nav');
  if (!el) return;
  const path = location.pathname;
  const items = [
    ['Vault', '/#vault'],
    ['Write', '/app/#write'],
    ['Buy', '/app/#buy'],
    ['Docs', '/docs/'],
    ['$' + CONFIG.ticker, '/token/'],
  ];
  el.className = 'nav';
  el.innerHTML = `
    <div class="nav-in">
      ${wordmark()}
      <nav class="nav-menu" aria-label="Main">
        ${items
          .map(([t, h]) => {
            const on = h !== '/#vault' && path.startsWith(h.split('#')[0]) && h.split('#')[0] !== '/';
            return `<a href="${h}"${on ? ' aria-current="page"' : ''}>${esc(t)}</a>`;
          })
          .join('')}
      </nav>
      ${CONFIG.links.x ? `<a class="nav-x" href="${esc(CONFIG.links.x)}" target="_blank" rel="noopener" aria-label="Brimstead on X (${esc(CONFIG.links.xHandle || 'X')})"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17.8 3h3.1l-6.8 7.7 8 10.3h-6.2l-4.9-6.3L5.4 21H2.3l7.2-8.2L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z"/></svg></a>` : ''}
      <a class="btn btn-hot btn-sm nav-cta" href="/app/">Open app</a>
      <button class="nav-toggle" aria-label="Menu" aria-expanded="false"><span></span><span></span></button>
    </div>`;
  const tog = $('.nav-toggle', el);
  tog.addEventListener('click', () => {
    const open = el.classList.toggle('open');
    tog.setAttribute('aria-expanded', String(open));
  });
  el.querySelectorAll('.nav-menu a').forEach((a) => a.addEventListener('click', () => el.classList.remove('open')));
}

function renderFooter() {
  const el = $('#foot');
  if (!el) return;
  const v = CONFIG.contracts.vault;
  const x = CONFIG.links.x;
  const repo = CONFIG.links.repo;
  const pons = hasCa() ? CONFIG.buyUrl(CONFIG.ca) : '';
  const d = CONFIG.contracts.drip;
  const ta = '<span class="tba">to be announced</span>';
  const dep = '<span class="tba">deploys before launch</span>';
  el.className = 'foot';
  el.innerHTML = `
    <div class="foot-in">
      <div class="foot-cols">
        <div><h4>Product</h4>
          <a href="/app/">App</a><a href="/app/#write">Write a call</a><a href="/app/#buy">Buy upside</a><a href="/app/#portfolio">Portfolio</a><a href="/stake/">Stake $${CONFIG.ticker}</a></div>
        <div><h4>Learn</h4>
          <a href="/docs/">Docs</a><a href="/risks/">Risks</a><a href="/token/">$${CONFIG.ticker}</a></div>
        <div><h4>On chain</h4>
          ${v ? `<a href="${explorerAddr(v)}" target="_blank" rel="noopener">BrimVault on Blockscout</a>` : `<span>BrimVault · ${dep}</span>`}
          ${d ? `<a href="${explorerAddr(d)}" target="_blank" rel="noopener">BrimDrip on Blockscout</a>` : `<span>BrimDrip · ${dep}</span>`}
          <a href="${CONFIG.explorer}" target="_blank" rel="noopener">Robinhood Chain explorer</a>
          ${repo ? `<a href="${esc(repo)}" target="_blank" rel="noopener">Source code</a>` : `<span>Source code ${ta}</span>`}</div>
        <div><h4>Elsewhere</h4>
          ${x ? `<a href="${esc(x)}" target="_blank" rel="noopener">X · ${esc(CONFIG.links.xHandle || '')}</a>` : `<span>X ${ta}</span>`}
          ${pons ? `<a href="${esc(pons)}" target="_blank" rel="noopener">$${CONFIG.ticker} on Pons</a>` : `<span>$${CONFIG.ticker} on Pons · ${esc(launchLabel())}</span>`}</div>
      </div>
      <div class="foot-mark" aria-hidden="true">${markSVG('foot-logo')}<span>Brimstead<span class="dot">.</span></span></div>
      <div class="foot-base">
        <span>Covered calls for tokenized stocks on Robinhood Chain (4663). Independently reviewed, not formally audited. No promised returns.</span>
        <span class="mono">All times UTC</span>
      </div>
    </div>`;
}

/** CA slot + copy + countdown + Buy. Renders into every [data-ca-strip]. */
function renderCa() {
  document.querySelectorAll('[data-ca-strip]').forEach((el) => {
    const live = hasCa();
    el.classList.add('ca-strip');
    el.innerHTML = `
      <span class="ca-tick">$${CONFIG.ticker}</span>
      <span class="ca-slot">
        <span class="ca-lbl">CA</span>
        <code class="ca-val">${live ? esc(CONFIG.ca) : `Not issued yet · launches ${esc(launchLabel())}`}</code>
        <button class="ca-copy" type="button" ${live ? '' : 'disabled'} aria-label="Copy contract address">${live ? 'Copy' : 'Copy'}</button>
      </span>
      ${live ? '' : `<span class="ca-count" data-countdown aria-live="off"></span>`}
      ${live ? `<a class="btn btn-hot btn-sm" href="${esc(CONFIG.buyUrl(CONFIG.ca))}" target="_blank" rel="noopener">Buy on Pons</a>` : ''}`;
    const btn = el.querySelector('.ca-copy');
    btn.addEventListener('click', async () => {
      if (!live) return;
      try {
        await navigator.clipboard.writeText(CONFIG.ca);
        btn.textContent = 'Copied';
      } catch {
        const r = document.createRange();
        r.selectNodeContents(el.querySelector('.ca-val'));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        btn.textContent = 'Selected';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1600);
    });
  });
}

function tickCountdown() {
  const els = document.querySelectorAll('[data-countdown]');
  if (!els.length) return;
  const p = (n) => String(n).padStart(2, '0');
  const draw = () => {
    let s = Math.max(0, Math.floor((launchMs - Date.now()) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const txt = launchMs <= Date.now() ? 'Launch time reached · CA appears here' : `${d}d ${p(h)}h ${p(m)}m ${p(s)}s`;
    els.forEach((e) => (e.textContent = txt));
  };
  draw();
  setInterval(draw, 1000);
}

export function initChrome() {
  renderNav();
  renderFooter();
  renderCa();
  tickCountdown();
}

initChrome();
// pages with their own choreography (landing) start motion themselves and set data-motion="custom" on <body>
export const motionReady = document.body.dataset.motion === 'custom' ? Promise.resolve(false) : initMotion();
