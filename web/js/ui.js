// Toast stack + transaction runner for /app and /stake: pending → submitted → confirmed (Blockscout link) → or the
// decoded revert (e.g. "InTheMoney: The live price is at or above the strike…").
import * as C from '/js/contract.js';
import { explorerTx } from '/js/common.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ICON = { pending: '<span class="t-spin" aria-hidden="true"></span>', ok: '✓', err: '!', info: 'i' };

function box() {
  let b = document.querySelector('[data-toasts]');
  if (!b) { b = document.createElement('div'); b.className = 'toasts'; b.dataset.toasts = ''; b.setAttribute('role', 'status'); document.body.appendChild(b); }
  return b;
}

/** Show or update a toast. Returns the element; pass it back as `el` to update it in place. */
export function toast({ kind = 'info', title, body = '', el = null, ttl = kind === 'pending' ? 0 : 7000 }) {
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    box().appendChild(el);
    if (window.gsap && !matchMedia('(prefers-reduced-motion: reduce)').matches) gsap.from(el, { y: 24, opacity: 0, duration: 0.35, ease: 'power3.out' });
  }
  el.className = `toast t-${kind}`;
  el.innerHTML = `<span class="t-ic">${ICON[kind] || ''}</span><span class="t-tx"><b>${esc(title)}</b>${body ? `<span>${body}</span>` : ''}</span><button class="t-x" type="button" aria-label="Dismiss">×</button>`;
  el.querySelector('.t-x').onclick = () => close(el);
  clearTimeout(el.__t);
  if (ttl) el.__t = setTimeout(() => close(el), ttl);
  return el;
}
function close(el) {
  if (window.gsap) gsap.to(el, { opacity: 0, y: 12, duration: 0.25, onComplete: () => el.remove() });
  else el.remove();
}

/** Run a wallet transaction with the full status sequence. Resolves with the hash, rejects on error (already shown). */
export async function runTx(label, fn, onDone) {
  const el = toast({ kind: 'pending', title: label, body: 'Confirm in your wallet…' });
  const onHash = (e) => toast({ el, kind: 'pending', title: label, body: `Submitted · waiting for confirmation · <a href="${explorerTx(e.detail)}" target="_blank" rel="noopener">view</a>` });
  C.txEvents.addEventListener('hash', onHash, { once: true });
  try {
    const hash = await fn();
    toast({ el, kind: 'ok', title: `${label} confirmed`, body: `<a href="${explorerTx(hash)}" target="_blank" rel="noopener">View on Blockscout</a>`, ttl: 10000 });
    if (onDone) await onDone();
    return hash;
  } catch (e) {
    const name = C.errorName(e);
    toast({ el, kind: 'err', title: name ? `${label} reverted: ${name}` : `${label} failed`, body: esc(C.explain(e)), ttl: 12000 });
    throw e;
  } finally {
    C.txEvents.removeEventListener('hash', onHash);
  }
}
export const info = (title, body = '') => toast({ kind: 'info', title, body });
export const warn = (title, body = '') => toast({ kind: 'err', title, body });
