// Chainlink reads over plain JSON-RPC (no wallet, no library). Never invents a number: on failure returns null.
import { CONFIG } from '/config.js';

const LATEST = '0xfeaf968c'; // latestRoundData()

const urls = () => [new URL(CONFIG.readRpc, location.origin).href, CONFIG.rpc];

async function rpc(url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('rpc ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function decode(hex) {
  if (!hex || hex.length < 2 + 64 * 5) return null;
  const w = (i) => BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  let answer = w(1);
  if (answer >> 255n) answer -= 1n << 256n; // int256
  const updatedAt = Number(w(3));
  if (answer <= 0n || !updatedAt) return null;
  return { roundId: w(0), answer, price: Number(answer) / 1e8, updatedAt };
}

/** Read latestRoundData for many feeds in one batch: same-origin /rpc first, publicnode as the fallback.
 *  Returns { [feed]: {price, answer, updatedAt, roundId} | null }. */
export async function readFeeds(feeds) {
  const out = {};
  feeds.forEach((f) => (out[f] = null));
  const body = feeds.map((to, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data: LATEST }, 'latest'] }));
  for (const url of urls()) {
    try {
      const res = await rpc(url, body);
      let got = 0;
      for (const r of Array.isArray(res) ? res : []) {
        if (r && r.result && feeds[r.id]) { out[feeds[r.id]] = decode(r.result); if (out[feeds[r.id]]) got++; }
      }
      if (got) return out;
    } catch {}
  }
  return out;
}

export async function readStock(sym) {
  const s = CONFIG.stocks.find((x) => x.sym === sym);
  if (!s) return null;
  const r = await readFeeds([s.feed]);
  return r[s.feed];
}

export const fmtUsd = (n) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtUtc(ts) {
  const d = new Date(ts * 1000);
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${mon} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
