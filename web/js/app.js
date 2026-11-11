// /app: write, buy, portfolio, settle & claim. Every number comes from Chainlink or BrimVault; none is invented.
import { CONFIG } from '/config.js';
import * as C from '/js/contract.js';
import { readFeeds, fmtUsd, fmtUtc } from '/js/feed.js';
import { short, explorerAddr } from '/js/common.js';
import { toast as T, runTx } from '/js/ui.js';
import { counter, RM } from '/js/motion.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const R = CONFIG.vaultRules;
const now = () => Math.floor(Date.now() / 1000);
const DEPLOYED = !!C.vaultAddr();
const NOT_DEPLOYED_TXT = 'Contracts deploy before launch — address appears here';

const S = { prices: {}, offers: [], positions: [], account: null, info: null, filter: 'ALL', loaded: !DEPLOYED, bal: null, sel: null };
const SKEL = '<div class="skel skel-row"></div>'.repeat(3);

// ───────────── helpers ─────────────
const stockOf = (sym) => CONFIG.stocks.find((s) => s.sym === sym);
const priceOf = (stock) => (stock ? S.prices[stock.feed] : null);
const usd8 = (v) => fmtUsd(Number(v) / 1e8);
const tok = (v, d = 18) => {
  const n = Number(C.formatUnits(v, d));
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 4 });
};
const eth = (v) => {
  const n = Number(C.formatUnits(v, 18));
  return (n === 0 ? '0' : n < 0.0001 ? n.toExponential(2) : n.toLocaleString('en-US', { maximumFractionDigits: 6 })) + ' ETH';
};
const fri = (t) => new Date(t * 1000).toLocaleString('en-GB', { weekday: 'short', timeZone: 'UTC' }) + ' ' + fmtUtc(t);
const addrLink = (a) => `<a href="${explorerAddr(a)}" target="_blank" rel="noopener">${short(a)}</a>`;
function ago(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}

// messages (already escaped where they include data) and transactions with full status toasts
const toast = (html) => T({ kind: 'err', title: 'Check this', body: html });
const run = (label, fn) => runTx(label, fn, refreshChain);

// ───────────── chrome: deploy state, wallet, tabs ─────────────
function drawDeployState() {
  const el = $('[data-deploy-state]');
  if (!DEPLOYED) {
    el.innerHTML = `<div class="ds"><span class="eyebrow"><span class="pip hot"></span>Vault</span><span><b>${NOT_DEPLOYED_TXT}.</b> Prices below are live from Chainlink; actions unlock when BrimVault is deployed and verified.</span></div>`;
    return;
  }
  const i = S.info;
  el.innerHTML = `<div class="ds ok"><span class="eyebrow"><span class="pip"></span>Vault</span>
    <code><a href="${explorerAddr(C.vaultAddr())}" target="_blank" rel="noopener">${C.vaultAddr()}</a></code>
    ${i ? `<span class="mono small muted">fee ${(i.feeBps / 100).toFixed(2)}% of premium · ${i.offerCount} offers · ${i.positionCount} positions</span>` : ''}</div>`;
}

function drawWallet({ account, chainOk, hasProvider }) {
  S.account = account;
  const b = $('[data-connect]'), n = $('[data-net]');
  if (account) {
    b.textContent = short(account);
    n.textContent = chainOk ? 'Robinhood Chain · 4663' : 'Wrong network: switch to 4663';
    n.classList.toggle('bad', !chainOk);
  } else {
    b.textContent = hasProvider ? 'Connect wallet' : 'No wallet found';
  }
  drawAll();
}

function tabs() {
  const ind = $('[data-tab-ind]');
  let first = true;
  const show = () => {
    const id = (location.hash || '#write').slice(1);
    const tab = ['write', 'buy', 'portfolio', 'settle'].includes(id) ? id : 'write';
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
    let on = null;
    $$('[data-tab]').forEach((a) => { const sel = a.dataset.tab === tab; a.setAttribute('aria-selected', String(sel)); if (sel) on = a; });
    // Flip the underline from the old tab into the new one; fade the panel in
    const anim = !first && !RM && window.Flip && window.gsap;
    const st = anim ? Flip.getState(ind) : null;
    on.appendChild(ind);
    if (st) {
      Flip.from(st, { duration: 0.45, ease: 'power3.inOut' });
      gsap.from(`[data-panel="${tab}"]`, { opacity: 0, y: 12, duration: 0.4, ease: 'power3.out' });
    }
    first = false;
  };
  addEventListener('hashchange', show);
  show();
}

// ───────────── write ─────────────
function fridays() {
  const out = [];
  const t0 = now();
  // next Friday 21:00 UTC on the vault grid: t % week == 45 h
  let t = t0 - (((t0 - 45 * 3600) % 604800) + 604800) % 604800 + 604800;
  for (; t <= t0 + R.maxTenorDays * 86400; t += 604800) if (t >= t0 + R.minTenorDays * 86400) out.push(t);
  return out;
}

function initWrite() {
  const sel = $('[data-stock]');
  sel.innerHTML = CONFIG.stocks.map((s) => `<option value="${s.sym}">${s.sym}</option>`).join('');
  $('[data-expiry]').innerHTML = fridays().map((t) => `<option value="${t}">${fri(t)}</option>`).join('');
  const f = $('[data-write-form]');
  f.addEventListener('input', drawWrite);
  sel.addEventListener('change', () => { drawWrite(); loadBalance(); });
  f.addEventListener('submit', onWrite);
  const btn = $('[data-w-submit]');
  if (!DEPLOYED) { btn.disabled = true; btn.textContent = 'Contracts deploy before launch'; }
}

function writeInputs() {
  const f = $('[data-write-form]');
  const stock = stockOf(f.stock.value);
  const num = (v) => (v.trim() === '' || !isFinite(+v) ? null : +v);
  return { stock, amount: num(f.amount.value), strike: num(f.strike.value), premium: num(f.premium.value), expiry: +f.expiry.value };
}

function marketState(stock) {
  const p = priceOf(stock);
  if (!p) return { ok: false, html: `<div class="m closed">Chainlink price unavailable right now. Writing needs a fresh price.</div>` };
  const age = now() - p.updatedAt;
  if (age > R.maxPriceAgeHours * 3600)
    return { ok: false, html: `<div class="m closed"><b>Market closed — writing reopens with the Monday print.</b> Last ${esc(stock.sym)} round was ${ago(age)} ago; the vault needs one from the last ${R.maxPriceAgeHours} hours.</div>` };
  return { ok: true, html: `<div class="m open">Market open · last ${esc(stock.sym)} round ${ago(age)} ago.</div>` };
}

function setMsg(name, msg, ok = false) {
  const m = document.querySelector(`[data-msg="${name}"]`);
  if (!m) return;
  m.textContent = msg || '';
  m.classList.toggle('ok', ok && !!msg);
  m.closest('.field').classList.toggle('invalid', !!msg && !ok);
}

let livePriceShown = null;
function drawWrite() {
  const f = $('[data-write-form]');
  const { stock, amount, strike, premium, expiry } = writeInputs();
  const p = priceOf(stock);
  const lp = $('[data-w-price]');
  if (p && livePriceShown !== stock.sym) { livePriceShown = stock.sym; counter(lp, p.price, fmtUsd, 0.9); }
  else if (!p) { lp.textContent = 'price unavailable'; livePriceShown = null; }
  $('[data-w-time]').textContent = p ? fmtUtc(p.updatedAt) : '·';
  const m = marketState(stock);
  $('[data-market]').innerHTML = m.html;

  // inline validation, field by field (only once the user has typed something)
  const bad = {};
  if (f.amount.value.trim()) {
    if (amount == null) bad.amount = 'Enter a number, e.g. 10 or 2.5.';
    else if (amount <= 0) bad.amount = 'Amount must be above zero.';
    else if (S.bal != null && amount > S.bal) bad.amount = `More than your balance (${S.bal.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${stock.sym}).`;
  }
  if (f.strike.value.trim()) {
    if (strike == null || strike <= 0) bad.strike = 'Enter a price in USD per token, e.g. 190.50.';
    // the vault requires strike > answer, strictly, in feed units (8 decimals)
    else if (p && C.parseUnits(strike.toFixed(8), 8) <= p.answer) bad.strike = `Must be strictly above the live price (${fmtUsd(p.price)}). An equal strike reverts with BadStrike.`;
  }
  if (f.premium.value.trim()) {
    if (premium == null) bad.premium = 'Enter ETH per token, e.g. 0.002.';
    else if (premium < 0) bad.premium = 'The premium cannot be negative.';
  }
  setMsg('amount', bad.amount);
  setMsg('strike', bad.strike || (strike > 0 && p ? `+${((strike / p.price - 1) * 100).toFixed(2)}% over the live price` : ''), !bad.strike);
  setMsg('premium', bad.premium || (premium === 0 && f.premium.value.trim() ? 'A zero premium is allowed: the call is free.' : ''), !bad.premium);
  $('[data-w-err]').textContent = '';
  const complete = amount > 0 && strike > 0 && premium != null && premium >= 0;
  const btn = $('[data-w-submit]');
  if (DEPLOYED) {
    btn.disabled = !m.ok || Object.values(bad).some(Boolean) || !complete;
    btn.textContent = !m.ok ? 'Market closed' : 'Write offer';
  }

  // sticky summary
  const feeBps = S.info ? S.info.feeBps : R.maxFeeBps;
  const fee = feeBps / 10000;
  const ok = complete && !bad.amount && !bad.strike && !bad.premium;
  const gross = ok ? amount * premium : null;
  const dash = '<span class="muted">·</span>';
  const ethS = (v) => (v == null ? dash : `${+v.toPrecision(6)} ETH`);
  const rows = ok ? [0.95, 1, 1.05, 1.1, 1.2].map((k) => {
    const P = strike * k, b2 = P > strike ? (amount * (P - strike)) / P : 0;
    return `<tr><td class="num">${fmtUsd(P)}</td><td class="num hot">${b2.toFixed(4)}</td><td class="num cobalt">${(amount - b2).toFixed(4)}</td></tr>`;
  }).join('') : '';
  $('[data-w-preview]').innerHTML = `<h3>Summary</h3>
    <dl class="sum">
      <dt>Locking</dt><dd>${amount > 0 ? `${amount} ${esc(stock.sym)}` : dash}</dd>
      <dt>Strike</dt><dd class="hot">${strike > 0 && !bad.strike ? fmtUsd(strike) : dash}</dd>
      <dt>Expiry</dt><dd>${expiry ? fri(expiry) : dash}</dd>
      <dt>Buying closes</dt><dd>${expiry ? fri(expiry - R.buyCutoffHours * 3600) : dash}</dd>
      <dt>Premium if all sold</dt><dd class="cobalt">${ethS(gross)}</dd>
      <dt>Protocol fee</dt><dd>${(feeBps / 100).toFixed(2)}% · ${ethS(gross == null ? null : gross * fee)}<small>taken at settlement, never on refunds</small></dd>
      <dt class="sum-total">You receive</dt><dd class="sum-total">${ethS(gross == null ? null : gross * (1 - fee))}</dd>
      <dt>Most buyers can get</dt><dd>${amount > 0 ? `less than ${amount} ${esc(stock.sym)}` : dash}<small>amount × (P − K) / P, only above the strike</small></dd>
    </dl>
    ${ok ? `<div class="tbl-scroll"><table class="tbl"><thead><tr><th>Example close</th><th>Buyers get</th><th>You keep</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="fine">Examples computed from your inputs, not forecasts. The close is the last Chainlink round at or before Friday 21:00 UTC.</p>` : '<p class="fine">Fill in amount, strike and premium to see the outcomes.</p>'}`;
}

async function loadBalance() {
  const el = $('[data-w-bal]');
  el.textContent = '';
  S.bal = null;
  const { stock } = writeInputs();
  if (!S.account || !stock) return;
  try {
    const m = await C.tokenMeta(stock.token, S.account);
    el.textContent = `balance ${tok(m.balance, m.decimals)}`;
    S.bal = Number(C.formatUnits(m.balance, m.decimals));
    drawWrite();
  } catch {}
}

async function onWrite(e) {
  e.preventDefault();
  if (!DEPLOYED) return;
  const { stock, amount, strike, premium, expiry } = writeInputs();
  if (!stock || !amount || !strike || premium == null) return;
  try {
    if (!S.account) await C.connect();
    const meta = await C.tokenMeta(stock.token, C.getAccount());
    const raw = C.parseUnits(String(amount), meta.decimals);
    if (raw > meta.balance) return toast(`Your ${esc(stock.sym)} balance is ${tok(meta.balance, meta.decimals)}.`);
    if (meta.allowance < raw) await run(`Approve ${stock.sym}`, () => C.approve(stock.token, raw));
    await run('Write offer', () =>
      C.writeOffer({ token: stock.token, amount: raw, strikeUsd: strike.toFixed(8), expiry, premiumEthPerToken: premium.toFixed(18) })
    );
    location.hash = '#portfolio';
  } catch {}
}

// ───────────── offers rendering ─────────────
const notDeployedBox = (what) => `<div class="empty-s"><b>${NOT_DEPLOYED_TXT}.</b>${what}</div>`;

function offerCells(o) {
  const sym = o.stock ? o.stock.sym : short(o.token);
  return `<span class="sym">${esc(sym)}</span>
    <span><span class="k">Strike</span><span class="v hot">${usd8(o.strike)}</span></span>
    <span><span class="k">Expiry</span><span class="v">${fri(o.expiry)}</span></span>
    <span><span class="k">Premium / token</span><span class="v cobalt">${eth(o.premiumPerToken)}</span></span>
    <span><span class="k">Available · writer</span><span class="v">${tok(o.available)} · ${addrLink(o.writer)}</span></span>`;
}

function drawBuy() {
  const list = $('[data-buy-list]');
  const chips = $('[data-chips]');
  const syms = ['ALL', ...CONFIG.stocks.map((s) => s.sym)];
  chips.innerHTML = syms.map((s) => `<button class="chip" type="button" data-chip="${s}" aria-pressed="${S.filter === s}">${s === 'ALL' ? 'All' : s}</button>`).join('');
  if (!DEPLOYED) return (list.innerHTML = notDeployedBox(' Open offers are read from BrimVault once it exists. None are shown before that.'));
  if (!S.loaded) return (list.innerHTML = SKEL);
  if (list.contains(document.activeElement) && document.activeElement.matches('input')) return; // don't wipe what the user is typing
  const open = S.offers.filter((o) => C.isBuyable(o));
  if (!open.length) return (list.innerHTML = `<div class="empty-s"><b>No open offers right now.</b>Every offer here is read from BrimVault. <a href="#write">Write the first one.</a></div>`);
  list.innerHTML = open
    .map((o) => {
      const p = priceOf(o.stock);
      const itm = p && BigInt(Math.round(p.price * 1e8)) >= o.strike;
      return `<div class="row" data-sym="${o.stock ? o.stock.sym : ''}" data-oid="${o.id}">
        ${offerCells(o)}
        <span class="act">${
          itm
            ? `<span class="note-s bad">Live price is at or above the strike: no longer buyable.</span>`
            : `<input inputmode="decimal" placeholder="amount" data-buy-amt aria-label="Amount to buy"><span class="note-s" data-buy-cost></span><button class="btn btn-hot btn-sm" type="button" data-buy>Buy</button>`
        }</span></div>`;
    })
    .join('');
  applyFilter(false);
}

function applyFilter(animate = true) {
  const rows = $$('[data-buy-list] .row');
  const Flip = window.Flip;
  const st = animate && Flip && window.gsap ? Flip.getState(rows) : null;
  rows.forEach((r) => (r.style.display = S.filter === 'ALL' || r.dataset.sym === S.filter ? '' : 'none'));
  if (st) Flip.from(st, { duration: 0.45, ease: 'power2.inOut', absolute: true, onEnter: (els) => gsap.fromTo(els, { opacity: 0 }, { opacity: 1, duration: 0.3 }), onLeave: (els) => gsap.to(els, { opacity: 0, duration: 0.2 }) });
}

function drawBuySummary() {
  const box = $('[data-buy-summary]');
  if (!box) return;
  const o = S.sel && S.offers.find((x) => x.id === S.sel.id);
  if (!o) {
    box.innerHTML = `<h3>Your purchase</h3><p class="muted small">Enter an amount on an offer to see what you pay and what you can receive.</p>`;
    return;
  }
  const sym = o.stock ? o.stock.sym : 'tokens';
  const amt = S.sel.amt;
  const dash = '<span class="muted">·</span>';
  const pay = amt > 0n ? C.premiumFor(amt, o.premiumPerToken) : null;
  const amtN = amt > 0n ? Number(C.formatUnits(amt, 18)) : null;
  const feeBps = S.info ? S.info.feeBps : R.maxFeeBps;
  box.innerHTML = `<h3>Your purchase</h3>
    <dl class="sum">
      <dt>Offer</dt><dd>${esc(sym)} · #${o.id}</dd>
      <dt>Strike</dt><dd class="hot">${usd8(o.strike)}</dd>
      <dt>Expiry</dt><dd>${fri(o.expiry)}</dd>
      <dt>Buying closes</dt><dd>${fri(o.expiry - R.buyCutoffHours * 3600)}</dd>
      <dt>Amount</dt><dd>${amtN != null ? `${amtN} ${esc(sym)}` : dash}</dd>
      <dt class="sum-total">You pay</dt><dd class="sum-total cobalt">${pay != null ? eth(pay) : dash}<small>held in the vault until the offer resolves</small></dd>
      <dt>Fee</dt><dd>none for you<small>the writer pays ${(feeBps / 100).toFixed(2)}% of the premium at settlement</small></dd>
      <dt>Max payout</dt><dd>${amtN != null ? `less than ${amtN} ${esc(sym)}` : dash}<small>amount × (P − K) / P at the Friday close</small></dd>
      <dt>Example</dt><dd>${amtN != null ? `close 10% above strike → ${(amtN * 0.1 / 1.1).toFixed(4)} ${esc(sym)}` : dash}<small>at or below the strike you receive nothing; refunds only if no valid close exists</small></dd>
    </dl>`;
}

function buyEvents() {
  $('[data-chips]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    S.filter = b.dataset.chip;
    $$('[data-chip]').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    applyFilter(true);
  });
  $('[data-buy-list]').addEventListener('input', (e) => {
    const row = e.target.closest('.row');
    if (!row || !e.target.matches('[data-buy-amt]')) return;
    const o = S.offers.find((x) => x.id === +row.dataset.oid);
    const out = row.querySelector('[data-buy-cost]');
    let amt = 0n;
    try { amt = C.parseUnits(e.target.value || '0', 18); } catch { amt = -1n; }
    row.classList.toggle('invalid', amt < 0n || amt > o.available);
    out.textContent = amt < 0n ? 'enter a number' : amt > o.available ? `only ${tok(o.available)} left` : amt > 0n ? '= ' + eth(C.premiumFor(amt, o.premiumPerToken)) : '';
    S.sel = { id: o.id, amt: amt > 0n && amt <= o.available ? amt : 0n };
    $$('[data-buy-list] .row').forEach((r) => r.classList.toggle('is-sel', r === row));
    drawBuySummary();
  });
  $('[data-buy-list]').addEventListener('click', async (e) => {
    if (!e.target.matches('[data-buy]')) return;
    const row = e.target.closest('.row');
    const o = S.offers.find((x) => x.id === +row.dataset.oid);
    let amt;
    try { amt = C.parseUnits(row.querySelector('[data-buy-amt]').value || '0', 18); } catch { amt = 0n; }
    if (amt <= 0n || amt > o.available) return toast('Enter an amount up to what is available.');
    try { await run('Buy', () => C.buy(o.id, amt, o.premiumPerToken)); } catch {}
  });
}

// ───────────── portfolio ─────────────
function payoutTokens(amount, price, strike) {
  return price > strike ? (amount * (price - strike)) / price : 0n;
}

async function drawPortfolio() {
  const owed = $('[data-owed]'), mo = $('[data-my-offers]'), mp = $('[data-my-positions]');
  if (!DEPLOYED) {
    owed.innerHTML = `<span class="muted">ETH owed to you by the vault</span><b class="mono">·</b>`;
    mo.innerHTML = notDeployedBox(' Your offers appear here once BrimVault exists.');
    mp.innerHTML = notDeployedBox(' Your positions appear here once BrimVault exists.');
    return;
  }
  if (!S.loaded) { owed.innerHTML = '<span class="skel skel-line"></span>'; mo.innerHTML = mp.innerHTML = SKEL; return; }
  if (!S.account) {
    owed.innerHTML = `<span class="muted">Connect a wallet to see your offers, positions and ETH owed.</span><button class="btn btn-ink btn-sm" type="button" data-connect2>Connect wallet</button>`;
    mo.innerHTML = mp.innerHTML = '';
    return;
  }
  const me = S.account.toLowerCase();
  let owedV = 0n;
  try { owedV = await C.ethOwed(S.account); } catch {}
  owed.innerHTML = `<span>ETH owed to you (premium after settlement, refunds): <b class="mono">${eth(owedV)}</b></span>
    <span class="form-actions">
      <button class="btn btn-hot btn-sm" type="button" data-withdraw ${owedV > 0n ? '' : 'disabled'}>Withdraw ETH</button>
      <details class="send-to"><summary>Send to another address</summary>
        <span class="send-row"><input placeholder="0x…" data-withdraw-to-addr aria-label="Recipient address" spellcheck="false">
        <button class="btn btn-sm" type="button" data-withdraw-to ${owedV > 0n ? '' : 'disabled'}>Send</button></span>
      </details>
    </span>`;

  const mine = S.offers.filter((o) => o.writer.toLowerCase() === me);
  mo.innerHTML = mine.length
    ? mine.map((o) => {
        let act = '';
        if (o.status === 0 && o.available > 0n) act += `<button class="btn btn-sm" type="button" data-cancel="${o.id}">Withdraw unsold</button>`;
        if (o.status !== 0 && !o.writerClaimed) act += `<button class="btn btn-hot btn-sm" type="button" data-cw="${o.id}">Claim tokens</button>`;
        const st = o.status === 1 ? `Settled at ${usd8(o.price)}` : C.STATUS[o.status];
        return `<div class="row">${offerCells(o)}<span class="act"><span class="note-s">${st} · sold ${tok(o.sold)} · escrow ${eth(o.escrow)}</span>${act}</span></div>`;
      }).join('')
    : `<div class="empty-s"><b>No offers from this wallet.</b><a href="#write">Write a call.</a></div>`;

  const pos = S.positions.filter((p) => p.buyer.toLowerCase() === me);
  mp.innerHTML = pos.length
    ? pos.map((p) => {
        const o = S.offers.find((x) => x.id === p.offerId);
        if (!o) return '';
        let st = 'Open until the close', act = '';
        if (o.status === 1) st = `Settled at ${usd8(o.price)} · you receive ${tok(payoutTokens(p.amount, o.price, o.strike))} ${o.stock ? o.stock.sym : ''}`;
        if (o.status === 2) st = `Refunded: premium ${eth(p.premium)} back`;
        if (o.status !== 0 && !p.claimed) act = `<button class="btn btn-hot btn-sm" type="button" data-cb="${p.id}">Claim</button>`;
        if (p.claimed) st += ' · claimed';
        return `<div class="row"><span class="sym">${o.stock ? o.stock.sym : '·'}</span>
          <span><span class="k">Strike</span><span class="v hot">${usd8(o.strike)}</span></span>
          <span><span class="k">Expiry</span><span class="v">${fri(o.expiry)}</span></span>
          <span><span class="k">Size · premium</span><span class="v">${tok(p.amount)} · ${eth(p.premium)}</span></span>
          <span><span class="k">Status</span><span class="v">${st}</span></span>
          <span class="act">${act}</span></div>`;
      }).join('')
    : `<div class="empty-s"><b>No calls bought from this wallet.</b><a href="#buy">See open offers.</a></div>`;
}

// ───────────── settle & claim ─────────────
function drawSettle() {
  const list = $('[data-settle-list]');
  if (!DEPLOYED) return (list.innerHTML = notDeployedBox(' Expired offers waiting for settlement appear here once BrimVault exists.'));
  if (!S.loaded) return (list.innerHTML = SKEL);
  const t = now();
  const due = S.offers.filter((o) => o.status === 0 && o.expiry <= t);
  const unclaimedW = S.offers.filter((o) => o.status !== 0 && !o.writerClaimed);
  const unclaimedB = S.positions.filter((p) => !p.claimed && S.offers.find((o) => o.id === p.offerId && o.status !== 0));
  if (!due.length && !unclaimedW.length && !unclaimedB.length)
    return (list.innerHTML = `<div class="empty-s"><b>Nothing to settle or claim.</b>Offers show up here after their Friday 21:00 UTC expiry.</div>`);
  const rows = due.map((o) => {
    const canRefund = t >= o.expiry + R.settleWindowDays * 86400;
    return `<div class="row">${offerCells(o)}<span class="act">
      <button class="btn btn-hot btn-sm" type="button" data-settle="${o.id}">Settle at close</button>
      ${canRefund ? `<button class="btn btn-sm" type="button" data-fallback="${o.id}">Refund (fallback)</button>` : `<span class="note-s">refund path opens ${fri(o.expiry + R.settleWindowDays * 86400)}</span>`}
    </span></div>`;
  });
  unclaimedW.forEach((o) => rows.push(`<div class="row">${offerCells(o)}<span class="act"><span class="note-s">${C.STATUS[o.status]} · writer has not claimed</span><button class="btn btn-sm" type="button" data-cw="${o.id}">Claim for writer</button></span></div>`));
  unclaimedB.forEach((p) => {
    const o = S.offers.find((x) => x.id === p.offerId);
    rows.push(`<div class="row"><span class="sym">${o.stock ? o.stock.sym : '·'}</span>
      <span><span class="k">Position</span><span class="v">#${p.id}</span></span>
      <span><span class="k">Buyer</span><span class="v">${addrLink(p.buyer)}</span></span>
      <span><span class="k">Size</span><span class="v">${tok(p.amount)}</span></span>
      <span><span class="k">Status</span><span class="v">${C.STATUS[o.status]}</span></span>
      <span class="act"><button class="btn btn-sm" type="button" data-cb="${p.id}">Claim for buyer</button></span></div>`);
  });
  list.innerHTML = rows.join('');
}

function actionEvents() {
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const find = (id) => S.offers.find((o) => o.id === +id);
    try {
      if (t.matches('[data-connect2]')) await C.connect();
      else if (t.matches('[data-withdraw]')) await run('Withdraw ETH', () => C.withdrawEth());
      else if (t.matches('[data-withdraw-to]')) {
        const to = document.querySelector('[data-withdraw-to-addr]').value.trim();
        if (!C.isAddress(to)) return toast('Enter a valid 0x address.');
        await run('Send ETH', () => C.withdrawEthTo(to));
      }
      else if (t.dataset.cancel) { const o = find(t.dataset.cancel); await run('Withdraw unsold', () => C.cancel(o.id, o.available)); }
      else if (t.dataset.cw) await run('Claim tokens', () => C.claimWriter(+t.dataset.cw));
      else if (t.dataset.cb) await run('Claim', () => C.claimBuyer(+t.dataset.cb));
      else if (t.dataset.settle) await run('Settle', () => C.settle(find(t.dataset.settle)));
      else if (t.dataset.fallback) await run('Refund', () => C.settleFallback(find(t.dataset.fallback)));
    } catch {}
  });
  $('[data-refresh]').addEventListener('click', () => refreshChain());
}

// ───────────── data ─────────────
async function refreshPrices() {
  S.prices = await readFeeds(CONFIG.stocks.map((s) => s.feed));
  drawWrite();
  if (DEPLOYED) drawBuy();
}
async function refreshChain() {
  if (!DEPLOYED) return drawAll();
  try {
    const [info, offers, positions] = await Promise.all([C.vaultInfo(), C.getOffers(), C.getPositions()]);
    Object.assign(S, { info, offers, positions, loaded: true });
  } catch (e) {
    toast('Could not read BrimVault right now: ' + esc(C.explain(e)));
  }
  drawAll();
}
function enter(sel) {
  if (RM || !window.gsap) return;
  gsap.from(`${sel} > .row, ${sel} > .empty-s`, { y: 16, opacity: 0, duration: 0.45, stagger: 0.05, ease: 'power3.out' });
}
function drawAll() {
  drawDeployState();
  drawWrite();
  drawBuy();
  drawPortfolio();
  drawSettle();
  if (S.loaded && !S.entered) { S.entered = true; ['[data-buy-list]', '[data-my-offers]', '[data-my-positions]', '[data-settle-list]'].forEach(enter); }
}

(async function boot() {
  tabs();
  initWrite();
  buyEvents();
  actionEvents();
  drawAll();
  $('[data-connect]').addEventListener('click', async () => {
    try { await C.connect(); loadBalance(); } catch (e) { toast(esc(C.explain(e))); }
  });
  C.onWallet(drawWallet);
  C.silentReconnect().then(loadBalance);
  await Promise.all([refreshPrices(), refreshChain()]);
  setInterval(refreshPrices, 60000);
  if (DEPLOYED) setInterval(refreshChain, 30000);
})();
