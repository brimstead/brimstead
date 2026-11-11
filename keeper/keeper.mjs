// Brimstead keeper (one run per invocation; systemd timer every 2 min). Mitigates review L-1, L-2, I-3, I-8:
//   1. every expired Open offer is settled at the Friday close as soon as round r+1 exists
//      (r = last round of the current phase with updatedAt <= expiry, proven by r+1 with updatedAt > expiry: same
//      search as web/js/contract.js findCloseRound and BrimVault._lastBefore). If settle is impossible and
//      now >= expiry + 4 days, settleFallback is used (the contract decides eligibility; we only send if eth_call passes).
//   2. BrimVault.ethOwed(BrimDrip) > 0  → withdrawEth(BrimDrip)   (fees reach the stakers' stream)
//   3. BrimDrip.canKick()               → kick()
// Every write is simulated with eth_call first; a tx is only sent when the simulation succeeds.
// KEEPER_MODE=simulate (default) never sends; KEEPER_MODE=live sends.
// The key comes from an encrypted Foundry keystore (Web3 Secret Storage v3) + password file; it is never logged.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scryptSync, pbkdf2Sync, createDecipheriv } from 'node:crypto'
import {
  createPublicClient, createWalletClient, http, fallback, defineChain, keccak256, formatEther, formatGwei, parseGwei,
  parseEther, BaseError, ContractFunctionRevertedError, getAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = process.env
const CHAIN_ID = 4663
const VAULT = getAddress(env.BRIM_VAULT || '0x9599EA610B86d196A2F3E7a476735F9AA5622ABc')
const DRIP = getAddress(env.BRIM_DRIP || '0x415E708435CA74a013b7E9E18B0C3fA79A61D429')
const RPC_URLS = (env.RPC_URLS || 'https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com').split(',').map((s) => s.trim()).filter(Boolean)
const MODE = env.KEEPER_MODE === 'live' ? 'live' : 'simulate'
const STATE_DIR = env.STATE_DIRECTORY || env.KEEPER_STATE_DIR || join(HERE, 'data')
const LOG_FILE = env.KEEPER_LOG_FILE || join(env.LOGS_DIRECTORY || STATE_DIR, 'keeper.log')
const STATE_FILE = join(STATE_DIR, 'state.json')
const STATUS_FILE = join(STATE_DIR, 'status.json')
const MAX_FEE = parseGwei(env.KEEPER_MAX_FEE_GWEI || '0.5') // cap on maxFeePerGas (RC base fee ~0.02 gwei)
const LOW_BALANCE = parseEther(env.KEEPER_LOW_BALANCE_ETH || '0.0001') // warn below this
const SETTLE_WINDOW = 4n * 86400n
const LONG_STOP = 30n * 86400n
const CRED = env.CREDENTIALS_DIRECTORY
const KEYSTORE = env.KEEPER_KEYSTORE || (CRED ? join(CRED, 'keystore') : null)
const PASSWORD_FILE = env.KEEPER_PASSWORD_FILE || (CRED ? join(CRED, 'password') : null)

const loadAbi = (f) => { const j = JSON.parse(readFileSync(join(HERE, 'abi', f), 'utf8')); return Array.isArray(j) ? j : j.abi }
const VAULT_ABI = loadAbi('BrimVault.json')
const DRIP_ABI = loadAbi('BrimDrip.json')
const FEED_ABI = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
  { type: 'function', name: 'getRoundData', stateMutability: 'view', inputs: [{ type: 'uint80' }], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
]

// ───────────── logging / files ─────────────
mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(dirname(LOG_FILE), { recursive: true })
const J = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x))
function rotate() { try { if (statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + '.1') } catch {} }
/** level INFO goes to journald only; ACTION / WARN / ERROR also to the log file. */
function log(level, msg, toFile = level !== 'INFO') {
  const line = `${new Date().toISOString()} ${level} ${msg}`
  ;(level === 'ERROR' || level === 'WARN' ? console.error : console.log)(line)
  if (toFile) { try { rotate(); appendFileSync(LOG_FILE, line + '\n') } catch (e) { console.error(`cannot write ${LOG_FILE}: ${e.message}`) } }
}
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const writeJson = (f, v) => { writeFileSync(f + '.tmp', J(v) + '\n'); renameSync(f + '.tmp', f) }

// ───────────── keystore (same decryptor as 226 Larderhood signer.mjs) ─────────────
function decryptKeystore(json, password) {
  const ks = typeof json === 'string' ? JSON.parse(json) : json
  const c = ks.crypto || ks.Crypto
  if (!c || c.cipher !== 'aes-128-ctr') throw new Error('keystore: unsupported cipher')
  const kp = c.kdfparams, pw = Buffer.from(String(password), 'utf8'), salt = Buffer.from(kp.salt, 'hex')
  let dk
  if (c.kdf === 'scrypt') dk = scryptSync(pw, salt, kp.dklen, { N: kp.n, r: kp.r, p: kp.p, maxmem: 256 * kp.n * kp.r + 1024 * 1024 })
  else if (c.kdf === 'pbkdf2') { if (kp.prf !== 'hmac-sha256') throw new Error('keystore: unsupported prf'); dk = pbkdf2Sync(pw, salt, kp.c, kp.dklen, 'sha256') } else throw new Error(`keystore: unsupported kdf ${c.kdf}`)
  const ct = Buffer.from(c.ciphertext, 'hex')
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ct])).slice(2)
  if (mac !== String(c.mac).toLowerCase()) throw new Error('keystore: wrong password')
  const d = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex'))
  return '0x' + Buffer.concat([d.update(ct), d.final()]).toString('hex').padStart(64, '0')
}
function loadAccount() {
  if (!KEYSTORE || !PASSWORD_FILE) throw new Error('no keystore configured (KEEPER_KEYSTORE + KEEPER_PASSWORD_FILE, or systemd LoadCredential keystore/password)')
  const pw = readFileSync(PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '')
  return privateKeyToAccount(decryptKeystore(readFileSync(KEYSTORE, 'utf8'), pw))
}

// ───────────── clients ─────────────
const chain = defineChain({ id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: RPC_URLS } } })
const transport = fallback(RPC_URLS.map((u) => http(u, { timeout: 15_000, retryCount: 1 })), { rank: false, retryCount: 1 })
const pub = createPublicClient({ chain, transport })

const errName = (e) => (e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError)?.data?.errorName || null : null)
const isRevert = (e) => e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError)
const short = (e) => String(e?.shortMessage || e?.message || e).split('\n')[0].slice(0, 200)

// ───────────── Chainlink close round (mirror of web/js/contract.js findCloseRound) ─────────────
async function roundAt(feed, id) {
  try {
    const r = await pub.readContract({ address: feed, abi: FEED_ABI, functionName: 'getRoundData', args: [id] })
    return r[0] === id ? { answer: r[1], updatedAt: r[3] } : null
  } catch (e) {
    if (isRevert(e)) return null // unknown round / phase: treated as missing, like BrimVault._round
    throw e // RPC failure: do not mistake it for a missing round
  }
}
async function findCloseRound(feed, expiry) {
  const l = await pub.readContract({ address: feed, abi: FEED_ABI, functionName: 'latestRoundData' })
  const latest = { roundId: l[0], updatedAt: l[3] }
  if (latest.updatedAt <= expiry) return { ready: false, reason: 'no Chainlink round after expiry yet' }
  const base = (latest.roundId >> 64n) << 64n
  let lo = 1n, hi = latest.roundId - base // invariant: round hi printed after expiry
  const first = await roundAt(feed, base + 1n)
  if (!first || first.updatedAt > expiry) return { ready: false, reason: 'feed phase began after expiry', roundId: base + 1n }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    const r = await roundAt(feed, base + mid)
    if (r && r.updatedAt <= expiry) lo = mid; else hi = mid
  }
  const close = await roundAt(feed, base + lo)
  return { ready: true, roundId: base + lo, answer: close?.answer, updatedAt: close?.updatedAt }
}

// ───────────── run ─────────────
const state = readJson(STATE_FILE, { nextId: 0, open: [], feeds: {}, notes: {}, lowBalance: false, lastAction: null })
state.notes ||= {}; state.feeds ||= {}; state.open ||= []
const run = { at: new Date().toISOString(), mode: MODE, actions: [], warnings: [], errors: [] }
let account, wallet, balance = null

function note(key, msg, level = 'INFO') { // log to file only when the message for this key changes (no spam every 2 min)
  if (state.notes[key] === msg) { log('INFO', msg, false); return }
  state.notes[key] = msg
  log(level === 'INFO' ? 'NOTE' : level, msg)
}
function warn(msg) { run.warnings.push(msg); log('WARN', msg) }

/** eth_call first; send only if it succeeds (and in live mode). Returns 'sent' | 'simulated' | 'reverted:<Err>' | 'skipped'. */
async function act(label, address, abi, functionName, args) {
  state.pending ||= {}
  const pend = state.pending[label]
  if (pend) { // a tx we sent earlier had no receipt yet: do not send a duplicate while it may still land
    let rc = null
    try { rc = await pub.getTransactionReceipt({ hash: pend.tx }) } catch {}
    if (rc) { log('ACTION', `${label}: earlier tx ${pend.tx} ${rc.status} in block ${rc.blockNumber}`); delete state.pending[label] }
    else if (Date.now() - pend.at < 10 * 60_000) { log('INFO', `${label}: tx ${pend.tx} still pending, waiting`, false); return 'skipped' }
    else { warn(`${label}: tx ${pend.tx} not mined after 10 min, re-evaluating`); delete state.pending[label] }
  }
  try {
    await pub.simulateContract({ account: account.address, address, abi, functionName, args })
  } catch (e) {
    if (isRevert(e)) return `reverted:${errName(e) || short(e)}`
    throw e
  }
  if (MODE !== 'live') {
    log('ACTION', `[simulate] ${label}: eth_call OK, would send ${functionName}(${args.map(String).join(', ')})`)
    run.actions.push({ label, fn: functionName, args, tx: null, status: 'simulated' })
    return 'simulated'
  }
  const gas = await pub.estimateContractGas({ account: account.address, address, abi, functionName, args })
  const block = await pub.getBlock()
  const base = block.baseFeePerGas ?? (await pub.getGasPrice())
  if (base * 2n > MAX_FEE) { warn(`${label}: base fee ${formatGwei(base)} gwei is above half the cap ${formatGwei(MAX_FEE)} gwei, not sending`); return 'skipped' }
  const maxFeePerGas = MAX_FEE < base * 4n ? MAX_FEE : base * 4n
  const gasLimit = (gas * 13n) / 10n
  const need = gasLimit * maxFeePerGas
  balance = await pub.getBalance({ address: account.address })
  if (balance < need) {
    warn(`UNDERFUNDED: keeper ${account.address} has ${formatEther(balance)} ETH, ${label} needs up to ${formatEther(need)} ETH. Fund the keeper; nothing sent.`)
    state.lowBalance = true
    return 'skipped'
  }
  const hash = await wallet.writeContract({ address, abi, functionName, args, gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: 0n })
  log('ACTION', `${label}: sent ${functionName}(${args.map(String).join(', ')}) tx ${hash}`)
  let status = 'pending'
  try {
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 })
    status = rc.status
    log(rc.status === 'success' ? 'ACTION' : 'ERROR', `${label}: tx ${hash} ${rc.status} in block ${rc.blockNumber}, gas ${rc.gasUsed}`)
  } catch (e) { warn(`${label}: no receipt yet for ${hash} (${short(e)}); will re-check next run`); state.pending[label] = { tx: hash, at: Date.now() } }
  const a = { at: new Date().toISOString(), label, fn: functionName, args, tx: hash, status }
  run.actions.push(a); state.lastAction = a
  return 'sent'
}

async function feedOf(token) {
  const k = token.toLowerCase()
  if (!state.feeds[k]) state.feeds[k] = await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'feedOf', args: [token] })
  return state.feeds[k]
}

async function stepOffers(now) {
  const count = await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'offerCount' })
  run.offerCount = Number(count)
  for (let id = state.nextId; id < run.offerCount; id++) { if (!state.open.includes(id)) state.open.push(id) }
  if (run.offerCount > state.nextId) log('NOTE', `new offers tracked: ${state.nextId}..${run.offerCount - 1}`)
  state.nextId = Math.max(state.nextId, run.offerCount)
  const keep = []
  for (const id of state.open) {
    const key = `offer${id}`
    try {
      const o = await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'offer', args: [BigInt(id)] })
      if (Number(o.status) !== 0) { log('NOTE', `offer ${id}: resolved (status ${['Open', 'Settled', 'FellBack'][Number(o.status)]}), untracked`); delete state.notes[key]; continue }
      if (o.sold === 0n && o.available === 0n) { log('NOTE', `offer ${id}: fully cancelled with nothing sold, nothing to resolve, untracked`); delete state.notes[key]; continue }
      const expiry = BigInt(o.expiry)
      if (now < expiry) { keep.push(id); continue }
      const feed = await feedOf(o.token)
      const r = await findCloseRound(feed, expiry)
      let settleRes = 'not ready'
      if (r.ready) {
        settleRes = await act(`settle offer ${id}`, VAULT, VAULT_ABI, 'settle', [BigInt(id), r.roundId])
        if (settleRes === 'sent' || settleRes === 'simulated') { if (settleRes === 'simulated') keep.push(id); delete state.notes[key]; continue }
        if (settleRes === 'skipped') { keep.push(id); continue }
      }
      if (now >= expiry + SETTLE_WINDOW) {
        const hint = r.roundId || 0n
        const fb = await act(`settleFallback offer ${id}`, VAULT, VAULT_ABI, 'settleFallback', [BigInt(id), hint])
        if (fb === 'sent') { delete state.notes[key]; continue }
        if (fb.startsWith('reverted')) note(key, `offer ${id}: settle ${r.ready ? settleRes : `not possible (${r.reason})`}; fallback ${fb}${now >= expiry + LONG_STOP ? '' : ' (waiting)'}`, 'WARN')
      } else {
        note(key, `offer ${id}: expired, settle ${r.ready ? settleRes : `not ready (${r.reason})`}; fallback opens at ${new Date(Number(expiry + SETTLE_WINDOW) * 1000).toISOString()}`)
      }
      keep.push(id)
    } catch (e) {
      keep.push(id)
      run.errors.push(`offer ${id}: ${short(e)}`); log('ERROR', `offer ${id}: ${short(e)}`)
    }
  }
  state.open = keep
  run.openTracked = keep.length
}

async function stepFees() {
  const owed = await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'ethOwed', args: [DRIP] })
  run.ethOwedDrip = formatEther(owed)
  if (owed === 0n) return
  const r = await act(`withdrawEth(BrimDrip) ${formatEther(owed)} ETH`, VAULT, VAULT_ABI, 'withdrawEth', [DRIP])
  if (r.startsWith('reverted')) note('fees', `withdrawEth(BrimDrip) simulation ${r}`, 'WARN')
}

async function stepKick() {
  const can = await pub.readContract({ address: DRIP, abi: DRIP_ABI, functionName: 'canKick' })
  run.canKick = can
  if (!can) return
  const r = await act('BrimDrip kick', DRIP, DRIP_ABI, 'kick', [])
  if (r.startsWith('reverted')) note('kick', `kick() simulation ${r}`, 'WARN')
}

async function main() {
  let fatal = null
  try {
    account = loadAccount()
    wallet = createWalletClient({ account, chain, transport })
    const id = await pub.getChainId()
    if (id !== CHAIN_ID) throw new Error(`wrong chain id ${id} (expected ${CHAIN_ID})`)
    const block = await pub.getBlock()
    run.block = Number(block.number)
    const now = block.timestamp // the contract compares against block.timestamp, not our clock
    balance = await pub.getBalance({ address: account.address })
    if (balance < LOW_BALANCE) {
      if (!state.lowBalance) warn(`LOW BALANCE: keeper ${account.address} has ${formatEther(balance)} ETH (< ${formatEther(LOW_BALANCE)}). It keeps simulating; sends are skipped when gas cannot be covered.`)
      else run.warnings.push('low balance')
      state.lowBalance = true
    } else if (state.lowBalance) { log('NOTE', `balance OK again: ${formatEther(balance)} ETH`); state.lowBalance = false }
    for (const [name, fn] of [['offers', () => stepOffers(now)], ['fees', stepFees], ['kick', stepKick]]) {
      try { await fn() } catch (e) { run.errors.push(`${name}: ${short(e)}`); log('ERROR', `${name}: ${short(e)}`) }
    }
  } catch (e) {
    fatal = short(e)
    run.errors.push(fatal); log('ERROR', `run aborted: ${fatal}`)
  }
  if (balance == null && account) { try { balance = await pub.getBalance({ address: account.address }) } catch {} }
  writeJson(STATE_FILE, state)
  const status = {
    lastRun: run.at, mode: MODE, ok: run.errors.length === 0, keeper: account?.address || null,
    balanceEth: balance == null ? null : formatEther(balance), lowBalance: !!state.lowBalance,
    block: run.block ?? null, offerCount: run.offerCount ?? null, openTracked: run.openTracked ?? state.open.length,
    ethOwedDrip: run.ethOwedDrip ?? null, canKick: run.canKick ?? null,
    actionsThisRun: run.actions, lastAction: state.lastAction, warnings: run.warnings, errors: run.errors,
    vault: VAULT, drip: DRIP, rpc: RPC_URLS,
  }
  writeJson(STATUS_FILE, status)
  log('INFO', `run ${status.ok ? 'ok' : 'with errors'} mode=${MODE} block=${status.block} offers=${status.offerCount} open=${status.openTracked} owedDrip=${status.ethOwedDrip} canKick=${status.canKick} actions=${run.actions.length} balance=${status.balanceEth}`)
  // exit 1 only when the whole run could not happen (keystore/RPC/chain): the unit shows "failed", the timer retries
  // in 2 min. No Restart= in the unit, so this never crash-loops.
  process.exitCode = fatal ? 1 : 0
}

await main()
