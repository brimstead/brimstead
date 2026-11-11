// /stake: BrimDrip. Every figure is read from the contract (real ABI in web/abi/BrimDrip.json); anything unreadable
// shows "·", never an estimate.
import * as C from '/js/contract.js';
import { short, explorerAddr } from '/js/common.js';
import { fmtUtc } from '/js/feed.js';
import { toast as T, runTx } from '/js/ui.js';
import { counter } from '/js/motion.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DEPLOYED = !!C.dripAddr();
const ZERO = '0x0000000000000000000000000000000000000000';
let D = null;
let vaultOwed = null; // fee credited to BrimDrip inside BrimVault, not yet moved

const fmt = (v, d = 18, max = 6) => (v == null ? '·' : Number(C.formatUnits(v, d)).toLocaleString('en-US', { maximumFractionDigits: max }));
const eth = (v) => (v == null ? '·' : fmt(v) + ' ETH');
const tokenAddr = () => (D && D.token && D.token !== ZERO ? D.token : null);

const toast = (html) => T({ kind: 'err', title: 'Check this', body: html });
let loaded = !DEPLOYED;

function draw() {
  const ds = $('[data-deploy-state]');
  if (!DEPLOYED) {
    ds.innerHTML = `<div class="ds"><span class="eyebrow"><span class="pip hot"></span>BrimDrip</span><span><b>Contracts deploy before launch — address appears here.</b> Stake, unstake, claim and Start stream unlock once BrimDrip is deployed and the $BRIM address is set.</span></div>`;
  } else {
    ds.innerHTML = `<div class="ds ok"><span class="eyebrow"><span class="pip hot"></span>BrimDrip</span><code><a href="${explorerAddr(C.dripAddr())}" target="_blank" rel="noopener">${C.dripAddr()}</a></code>
      ${tokenAddr() ? `<span class="mono small muted">staking token ${short(tokenAddr())}</span>` : `<span class="mono small"><b>Staking opens after launch</b></span>`}</div>`;
  }

  const now = Date.now() / 1000;
  const running = D && D.periodFinish != null && Number(D.periodFinish) > now;
  const perDay = D && D.rewardRate != null ? (running ? D.rewardRate * 86400n : 0n) : null;
  const stat = (k, v, sub = '', hot = false) => `<div class="stat"><div class="k">${k}</div><div class="v${hot ? ' hot' : ''}">${loaded ? v : '<span class="skel skel-line"></span>'}</div>${sub && loaded ? `<div class="s">${sub}</div>` : ''}</div>`;
  $('[data-stats]').innerHTML = [
    stat('Total staked', D && D.totalStaked != null ? fmt(D.totalStaked, 18, 2) + ' BRIM' : '·'),
    stat('Stream rate', perDay != null ? eth(perDay) + ' / day' : '·',
      D && D.periodFinish != null ? (running ? `until ${fmtUtc(Number(D.periodFinish))}` : 'no stream running') : '', true),
    stat('Queued', D ? eth(D.queued) : '·', 'waits until 0.005 ETH'),
    stat(D && D.received != null ? 'ETH received' : 'ETH in BrimDrip',
      D ? eth(D.received != null ? D.received : D.ethBal) : '·',
      D && D.received != null ? 'balance + all claims' : D ? `left to stream + queued: ${eth(D.pending)}` : ''),
  ].join('');
  // tick the live numbers up the first time they arrive
  if (loaded && !draw.ticked) {
    draw.ticked = true;
    document.querySelectorAll('[data-stats] .stat .v').forEach((el) => {
      const m = el.textContent.match(/^([\d,.]+)\s(.*)$/);
      if (!m) return;
      const n = Number(m[1].replace(/,/g, ''));
      const dp = (m[1].split('.')[1] || '').length;
      counter(el, n, (v) => `${v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })} ${m[2]}`, 1);
    });
  }

  // Start stream (kick) + vault fees waiting to be moved into BrimDrip
  const kb = $('[data-kick]');
  if (!DEPLOYED) {
    kb.innerHTML = `<p><b>Start stream.</b> Incoming ETH waits in a queue until at least 0.005 ETH has gathered; then a new 7-day stream starts. Anyone can start it when it is ready.</p><button class="btn btn-hot btn-sm" type="button" disabled>Start stream</button>`;
  } else {
    const min = D && D.minRestart != null ? eth(D.minRestart) : '0.005 ETH';
    const why = !tokenAddr() ? 'Staking opens after launch.' : D && D.totalStaked === 0n ? 'Nobody is staked yet.' : D && D.queued != null && D.minRestart != null && D.queued < D.minRestart ? `Queued ${eth(D.queued)} of the ${min} needed; small payments wait until they add up.` : '';
    kb.innerHTML = `<p><b>Start stream.</b> ${D && D.canKick ? `Ready: ${eth(D.queued)} is queued. Starting spreads it, plus what is left of the current stream, over the next 7 days.` : `Not ready. ${esc(why)}`}
      ${vaultOwed && vaultOwed > 0n ? `<br>Vault fees waiting to be moved into BrimDrip: <b class="mono">${eth(vaultOwed)}</b>.` : ''}</p>
      <span class="form-actions">
        ${vaultOwed && vaultOwed > 0n ? `<button class="btn btn-sm" type="button" data-pull>Move vault fees</button>` : ''}
        <button class="btn btn-hot btn-sm" type="button" data-kickbtn ${D && D.canKick ? '' : 'disabled'}>Start stream</button>
      </span>`;
  }

  $('[data-my-staked]').textContent = D && D.staked != null ? fmt(D.staked, 18, 4) + ' BRIM' : '·';
  $('[data-my-earned]').textContent = D && D.earned != null ? eth(D.earned) : '·';
  const live = DEPLOYED && !!tokenAddr();
  ['[data-stake]', '[data-unstake]', '[data-claim]'].forEach((s) => ($(s).disabled = !live));
  $('[data-err]').textContent = DEPLOYED && D && !tokenAddr() ? 'Staking opens after launch.' : '';
}

async function refresh() {
  if (!DEPLOYED) return draw();
  try { D = await C.dripInfo(C.getAccount()); } catch (e) { toast('Could not read BrimDrip: ' + esc(C.explain(e))); }
  loaded = true;
  try { vaultOwed = C.vaultAddr() ? await C.ethOwed(C.dripAddr()) : null; } catch { vaultOwed = null; }
  if (C.getAccount() && tokenAddr()) {
    try {
      const b = await C.pub.readContract({ address: tokenAddr(), abi: C.ERC20, functionName: 'balanceOf', args: [C.getAccount()] });
      $('[data-my-bal]').textContent = fmt(b, 18, 4) + ' BRIM';
    } catch {}
  }
  draw();
}

const run = (label, fn) => runTx(label, fn, refresh).catch(() => {});

function amount() {
  try { const v = C.parseUnits($('[data-amt]').value.trim() || '0', 18); return v > 0n ? v : null; } catch { return null; }
}

(function boot() {
  draw();
  $('[data-connect]').addEventListener('click', async () => { try { await C.connect(); refresh(); } catch (e) { toast(esc(C.explain(e))); } });
  C.onWallet(({ account, chainOk }) => {
    $('[data-connect]').textContent = account ? short(account) : 'Connect wallet';
    const n = $('[data-net]');
    n.textContent = account && !chainOk ? 'Wrong network: switch to 4663' : 'Robinhood Chain · 4663';
    n.classList.toggle('bad', !!account && !chainOk);
    refresh();
  });
  C.silentReconnect();
  $('[data-stake]').addEventListener('click', async () => {
    const a = amount();
    if (!a) return toast('Enter an amount of $BRIM.');
    try { if (!C.getAccount()) await C.connect(); } catch (e) { return toast(esc(C.explain(e))); }
    const allow = await C.pub.readContract({ address: tokenAddr(), abi: C.ERC20, functionName: 'allowance', args: [C.getAccount(), C.dripAddr()] }).catch(() => 0n);
    if (allow < a) await run('Approve $BRIM', () => C.approve(tokenAddr(), a, C.dripAddr()));
    await run('Stake', () => C.dripStake(a));
  });
  $('[data-unstake]').addEventListener('click', () => { const a = amount(); if (!a) return toast('Enter an amount of $BRIM.'); run('Unstake', () => C.dripUnstake(a)); });
  $('[data-claim]').addEventListener('click', () => run('Claim ETH', () => C.dripClaim()));
  $('[data-kick]').addEventListener('click', (e) => {
    if (e.target.matches('[data-kickbtn]')) run('Start stream', () => C.dripKick());
    if (e.target.matches('[data-pull]')) run('Move vault fees', () => C.withdrawEth(C.dripAddr()));
  });
  refresh();
  if (DEPLOYED) setInterval(refresh, 30000);
})();
