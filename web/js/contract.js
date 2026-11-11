// The single chain module: wallet (EIP-1193, add/switch to 4663), BrimVault + BrimDrip reads/writes, Chainlink rounds.
// Addresses come from config.js, ABIs from web/abi/*.json (the real compiler output, paths in config.js). Empty address = not deployed: every write
// throws NOT_DEPLOYED and the UI shows the "deploys before launch" state. Nothing here ever invents a number.
import {
  createPublicClient, createWalletClient, custom, http, fallback, defineChain, parseAbi, getAddress, isAddress, parseAbiItem,
  formatUnits, parseUnits, BaseError, ContractFunctionRevertedError, UserRejectedRequestError,
} from 'viem';
import { CONFIG } from '/config.js';

export const chain = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: CONFIG.nativeCurrency,
  rpcUrls: { default: { http: [CONFIG.rpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: CONFIG.explorer } },
});
export const CHAIN_HEX = '0x' + CONFIG.chainId.toString(16);
const READ_RPC = new URL(CONFIG.readRpc, location.origin).href;
// reads: same-origin /rpc proxy (official RPC, full history for getLogs), publicnode only if /rpc fails
export const pub = createPublicClient({
  chain,
  transport: fallback([
    http(READ_RPC, { batch: { wait: 16 }, timeout: 15000 }),
    http(CONFIG.rpc, { batch: { wait: 16 }, timeout: 15000 }),
  ]),
});

export const vaultAddr = () => (isAddress(CONFIG.contracts.vault || '') ? getAddress(CONFIG.contracts.vault) : null);
export const dripAddr = () => (isAddress(CONFIG.contracts.drip || '') ? getAddress(CONFIG.contracts.drip) : null);
export const NOT_DEPLOYED = 'NOT_DEPLOYED';

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const FEED = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 id) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function phaseId() view returns (uint16)',
]);
export const STATUS = ['Open', 'Settled', 'Refunded'];

// ───────────── ABIs (real files only; no hand-written fallback) ─────────────
async function loadAbi(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error('ABI missing: ' + path);
  const j = await r.json();
  const abi = Array.isArray(j) ? j : j.abi;
  if (!Array.isArray(abi) || !abi.length) throw new Error('ABI empty: ' + path);
  return abi;
}
let abis = null;
export async function getAbis() {
  if (!abis) {
    const [vault, drip] = await Promise.all([loadAbi(CONFIG.abis.vault), loadAbi(CONFIG.abis.drip)]);
    abis = { vault, drip };
  }
  return abis;
}

// ───────────── wallet ─────────────
let wallet = null;
let account = null;
const subs = new Set();
export const onWallet = (f) => (subs.add(f), () => subs.delete(f));
const emit = () => subs.forEach((f) => f({ account, chainOk: wallet?.chainOk ?? false, hasProvider: !!window.ethereum }));
export const getAccount = () => account;

export async function connect() {
  const eth = window.ethereum;
  if (!eth) throw new Error('No browser wallet found. Install one (for example MetaMask or Rabby) and reload.');
  const accs = await eth.request({ method: 'eth_requestAccounts' });
  account = accs && accs[0] ? getAddress(accs[0]) : null;
  await ensureChain();
  wallet = { client: createWalletClient({ chain, transport: custom(eth) }), chainOk: true };
  if (!eth.__brim) {
    eth.__brim = true;
    eth.on?.('accountsChanged', (a) => { account = a && a[0] ? getAddress(a[0]) : null; emit(); });
    eth.on?.('chainChanged', (c) => { if (wallet) wallet.chainOk = parseInt(c, 16) === CONFIG.chainId; emit(); });
  }
  emit();
  return account;
}

export async function ensureChain() {
  const eth = window.ethereum;
  const cur = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
  if (cur === CONFIG.chainId) return;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    if (e && (e.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not added/i.test(e.message || ''))) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX, chainName: CONFIG.chainName, nativeCurrency: CONFIG.nativeCurrency,
          rpcUrls: [CONFIG.rpc], blockExplorerUrls: [CONFIG.explorer],
        }],
      });
    } else throw e;
  }
  if (wallet) wallet.chainOk = true;
}

export async function silentReconnect() {
  const eth = window.ethereum;
  if (!eth) return emit();
  try {
    const accs = await eth.request({ method: 'eth_accounts' });
    if (accs && accs[0]) {
      account = getAddress(accs[0]);
      const cur = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
      wallet = { client: createWalletClient({ chain, transport: custom(eth) }), chainOk: cur === CONFIG.chainId };
    }
  } catch {}
  emit();
}

/** Fires 'hash' as soon as the wallet returns a transaction hash (before the receipt). */
export const txEvents = new EventTarget();

async function send({ address, abi, functionName, args = [], value }) {
  if (!address) throw new Error(NOT_DEPLOYED);
  if (!account) await connect();
  await ensureChain();
  const { request } = await pub.simulateContract({ address, abi, functionName, args, value, account });
  const hash = await wallet.client.writeContract(request);
  txEvents.dispatchEvent(new CustomEvent('hash', { detail: hash }));
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('Transaction reverted');
  return hash;
}

const ERR_TEXT = {
  UnknownToken: 'This stock is not listed in the vault.',
  BadAmount: 'Amount is zero or above what is available.',
  BadStrike: 'The strike must be strictly above the live Chainlink price.',
  BadExpiry: 'Expiry must be a Friday 21:00 UTC between 1 and 28 days from now.',
  BadPrice: 'The Chainlink price is too old or the issuer has paused the oracle. Market closed: writing reopens with the Monday print.',
  FeeOnTransfer: 'This token takes a fee on transfer; the vault refuses it.',
  NotWriter: 'Only the writer can do this.',
  NotOpen: 'This offer is not open (already resolved, or not resolved yet).',
  BuyClosed: 'Buying closes 2 hours before expiry.',
  PremiumTooHigh: 'The premium is higher than the ETH sent.',
  TooEarly: 'Too early for this step.',
  BadRound: 'That Chainlink round is not the Friday close for this expiry.',
  IssuerHold: 'The issuer paused the oracle or scheduled a corporate action around expiry; this offer resolves by refund.',
  NotEligible: 'A refund is not allowed: a valid settlement price exists. Use Settle.',
  AlreadyClaimed: 'Already claimed.',
  RefundFailed: 'The ETH transfer to this address failed.',
  InTheMoney: 'The live price is at or above the strike, so this call can no longer be bought.',
  TokenNotSet: 'Staking opens after launch: the $BRIM address is not set in BrimDrip yet.',
  NotReady: 'A stream cannot start yet: it needs at least 0.005 ETH queued, someone staked, and the token set.',
  BadToken: 'Wrong token.',
  SendFailed: 'The ETH transfer failed.',
};
/** The decoded custom error name of a revert (e.g. 'InTheMoney'), or null. */
export function errorName(e) {
  if (!(e instanceof BaseError)) return null;
  const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return rev?.data?.errorName || null;
}
export function explain(e) {
  if (!e) return 'Unknown error';
  if (e.message === NOT_DEPLOYED) return 'Contracts deploy before launch: the address appears here.';
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return 'Request rejected in the wallet.';
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = rev?.data?.errorName;
    if (name) return ERR_TEXT[name] || name;
    return e.shortMessage || e.message;
  }
  if (e.code === 4001) return 'Request rejected in the wallet.';
  return e.message || String(e);
}

// ───────────── Chainlink ─────────────
export async function latestRound(feed) {
  const r = await pub.readContract({ address: feed, abi: FEED, functionName: 'latestRoundData' });
  return { roundId: r[0], answer: r[1], updatedAt: Number(r[3]) };
}
async function roundAt(feed, id) {
  try {
    const r = await pub.readContract({ address: feed, abi: FEED, functionName: 'getRoundData', args: [id] });
    return r[0] === id ? { answer: r[1], updatedAt: Number(r[3]) } : null;
  } catch {
    return null;
  }
}
/**
 * The Friday-close round for `expiry`: the LAST round of the current phase with updatedAt <= expiry, proven by
 * round + 1 having updatedAt > expiry. Binary search over aggregator round ids. Returns null if it cannot exist yet.
 */
export async function findCloseRound(feed, expiry) {
  const latest = await latestRound(feed);
  if (latest.updatedAt <= expiry) return { ready: false, reason: 'No Chainlink round after expiry yet.' };
  const phase = latest.roundId >> 64n;
  const base = phase << 64n;
  let lo = 1n, hi = latest.roundId - base; // invariant: round hi printed after expiry
  const first = await roundAt(feed, base + 1n);
  if (!first || first.updatedAt > expiry) return { ready: false, reason: 'The feed phase began after expiry.', phaseAfter: true, roundId: base + 1n };
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const r = await roundAt(feed, base + mid);
    if (r && r.updatedAt <= expiry) lo = mid; else hi = mid;
  }
  const close = await roundAt(feed, base + lo);
  return { ready: true, roundId: base + lo, answer: close.answer, updatedAt: close.updatedAt };
}

// ───────────── vault reads ─────────────
export async function vaultInfo() {
  const address = vaultAddr();
  if (!address) return null;
  const { vault } = await getAbis();
  const [feeBps, feeRecipient, offerCount, positionCount] = await Promise.all([
    pub.readContract({ address, abi: vault, functionName: 'feeBps' }),
    pub.readContract({ address, abi: vault, functionName: 'feeRecipient' }),
    pub.readContract({ address, abi: vault, functionName: 'offerCount' }),
    pub.readContract({ address, abi: vault, functionName: 'positionCount' }),
  ]);
  return { address, feeBps: Number(feeBps), feeRecipient, offerCount: Number(offerCount), positionCount: Number(positionCount) };
}

const stockByToken = (t) => CONFIG.stocks.find((s) => s.token.toLowerCase() === String(t).toLowerCase());

export async function getOffers({ limit = 300 } = {}) {
  const address = vaultAddr();
  if (!address) return [];
  const { vault } = await getAbis();
  const n = Number(await pub.readContract({ address, abi: vault, functionName: 'offerCount' }));
  const from = Math.max(0, n - limit);
  const ids = Array.from({ length: n - from }, (_, i) => from + i);
  const rows = await Promise.all(ids.map((id) => pub.readContract({ address, abi: vault, functionName: 'offer', args: [BigInt(id)] })));
  return rows.map((o, i) => ({ id: ids[i], ...o, status: Number(o.status), expiry: Number(o.expiry), stock: stockByToken(o.token) })).reverse();
}

export async function getPositions({ limit = 600 } = {}) {
  const address = vaultAddr();
  if (!address) return [];
  const { vault } = await getAbis();
  const n = Number(await pub.readContract({ address, abi: vault, functionName: 'positionCount' }));
  const from = Math.max(0, n - limit);
  const ids = Array.from({ length: n - from }, (_, i) => from + i);
  const rows = await Promise.all(ids.map((id) => pub.readContract({ address, abi: vault, functionName: 'position', args: [BigInt(id)] })));
  return rows.map((p, i) => ({ id: ids[i], ...p, offerId: Number(p.offerId) })).reverse();
}

export async function ethOwed(who) {
  const address = vaultAddr();
  if (!address || !who) return 0n;
  const { vault } = await getAbis();
  return pub.readContract({ address, abi: vault, functionName: 'ethOwed', args: [who] });
}

/** Open offers a buyer can take right now: Open, available > 0, before expiry − 2 h. (ITM is checked per row.) */
export function isBuyable(o, nowSec = Date.now() / 1000) {
  return o.status === 0 && o.available > 0n && nowSec + CONFIG.vaultRules.buyCutoffHours * 3600 < o.expiry;
}

export async function tokenMeta(token, who) {
  const [dec, bal, allow] = await Promise.all([
    pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
    who ? pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] }) : 0n,
    who && vaultAddr() ? pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [who, vaultAddr()] }) : 0n,
  ]);
  return { decimals: Number(dec), balance: bal, allowance: allow };
}

// ───────────── vault writes ─────────────
export async function approve(token, amount, spender = vaultAddr()) {
  return send({ address: token, abi: ERC20, functionName: 'approve', args: [spender, amount] });
}
export async function writeOffer({ token, amount, strikeUsd, expiry, premiumEthPerToken }) {
  const { vault } = await getAbis();
  const strike = parseUnits(String(strikeUsd), 8);
  const ppt = parseUnits(String(premiumEthPerToken), 18);
  return send({ address: vaultAddr(), abi: vault, functionName: 'write', args: [token, amount, strike, BigInt(expiry), ppt] });
}
export function premiumFor(amount, premiumPerToken) {
  const num = amount * premiumPerToken;
  return num / 10n ** 18n + (num % 10n ** 18n ? 1n : 0n); // ceil, as the contract does
}
export async function buy(offerId, amount, premiumPerToken) {
  const { vault } = await getAbis();
  const premium = premiumFor(amount, premiumPerToken);
  return send({ address: vaultAddr(), abi: vault, functionName: 'buy', args: [BigInt(offerId), amount, premium], value: premium });
}
export async function cancel(offerId, amount) {
  const { vault } = await getAbis();
  return send({ address: vaultAddr(), abi: vault, functionName: 'cancel', args: [BigInt(offerId), amount] });
}
export async function settle(offer) {
  const { vault } = await getAbis();
  const r = await findCloseRound(offer.stock.feed, offer.expiry);
  if (!r.ready) throw new Error(r.reason);
  return send({ address: vaultAddr(), abi: vault, functionName: 'settle', args: [BigInt(offer.id), r.roundId] });
}
export async function settleFallback(offer) {
  const { vault } = await getAbis();
  let hint = 0n;
  try { const r = await findCloseRound(offer.stock.feed, offer.expiry); hint = r.roundId || 0n; } catch {}
  return send({ address: vaultAddr(), abi: vault, functionName: 'settleFallback', args: [BigInt(offer.id), hint] });
}
export async function claimBuyer(positionId) {
  const { vault } = await getAbis();
  return send({ address: vaultAddr(), abi: vault, functionName: 'claimBuyer', args: [BigInt(positionId)] });
}
export async function claimWriter(offerId) {
  const { vault } = await getAbis();
  return send({ address: vaultAddr(), abi: vault, functionName: 'claimWriter', args: [BigInt(offerId)] });
}
/** Pay the caller's own ethOwed to another address (BrimVault.withdrawEthTo). */
export async function withdrawEthTo(to) {
  const { vault } = await getAbis();
  if (!isAddress(to)) throw new Error('Not a valid address.');
  return send({ address: vaultAddr(), abi: vault, functionName: 'withdrawEthTo', args: [getAddress(to)] });
}
export async function withdrawEth(who = account) {
  const { vault } = await getAbis();
  return send({ address: vaultAddr(), abi: vault, functionName: 'withdrawEth', args: [who] });
}

// ───────────── BrimDrip ─────────────
// getLogs only through the same-origin /rpc (official RPC); publicnode rejects these ranges, so no fallback here.
const logsClient = createPublicClient({ chain, transport: http(READ_RPC, { timeout: 20000 }) });
const CLAIMED = parseAbiItem('event Claimed(address indexed user, uint256 amount)');
/** Sum of all Claimed amounts since deployBlock, or null when it cannot be read (no deployBlock / RPC refuses). */
async function claimedTotal(address) {
  const from = BigInt(CONFIG.contracts.deployBlock || 0);
  if (!from) return null;
  try {
    const head = await pub.getBlockNumber();
    const STEP = 400_000n;
    let sum = 0n;
    for (let a = from; a <= head; a += STEP) {
      const b = a + STEP - 1n > head ? head : a + STEP - 1n;
      const logs = await logsClient.getLogs({ address, event: CLAIMED, fromBlock: a, toBlock: b });
      for (const l of logs) sum += l.args.amount;
    }
    return sum;
  } catch {
    return null;
  }
}
/** Everything the stake page shows, read from BrimDrip. Unreadable values are null and render as "·". */
export async function dripInfo(who) {
  const address = dripAddr();
  if (!address) return null;
  const { drip } = await getAbis();
  const rd = (functionName, args = []) => pub.readContract({ address, abi: drip, functionName, args }).catch(() => null);
  const [token, totalStaked, rewardRate, periodFinish, lastUpdate, queued, pending, canKick, minRestart, duration, ethBal, claimed, staked, earned] =
    await Promise.all([
      rd('token'), rd('totalStaked'), rd('rewardRate'), rd('periodFinish'), rd('lastUpdate'), rd('queued'), rd('pending'),
      rd('canKick'), rd('MIN_RESTART'), rd('DURATION'), pub.getBalance({ address }).catch(() => null), claimedTotal(address),
      who ? rd('balanceOf', [who]) : null, who ? rd('earned', [who]) : null,
    ]);
  const received = ethBal != null && claimed != null ? ethBal + claimed : null;
  return { address, token, totalStaked, rewardRate, periodFinish, lastUpdate, queued, pending, canKick, minRestart, duration, ethBal, claimed, received, staked, earned };
}
export async function dripStake(amount) {
  const { drip } = await getAbis();
  return send({ address: dripAddr(), abi: drip, functionName: 'stake', args: [amount] });
}
export async function dripUnstake(amount) {
  const { drip } = await getAbis();
  return send({ address: dripAddr(), abi: drip, functionName: 'unstake', args: [amount] });
}
export async function dripClaim() {
  const { drip } = await getAbis();
  return send({ address: dripAddr(), abi: drip, functionName: 'claim', args: [] });
}
export async function dripKick() {
  const { drip } = await getAbis();
  return send({ address: dripAddr(), abi: drip, functionName: 'kick', args: [] });
}
export { ERC20, formatUnits, parseUnits, isAddress };
