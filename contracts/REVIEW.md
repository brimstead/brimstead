# BrimVault + BrimDrip: independent security review

- **Date:** 11-11-2026, before the planned mainnet deploy on Robinhood Chain (chain 4663).
- **Scope:** `src/BrimVault.sol`, `src/BrimDrip.sol`, `script/Deploy.s.sol` and `script/LaunchSet.sol`. SPEC.md was treated as a set of claims to check, not as the source of truth.
- **Method:**
  - Read the code line by line.
  - Ran `forge test`: 76/76 pass, i.e. the 66 original tests plus 10 review tests under `test/review/`.
  - Ran fork tests against the archive RPC `https://robinhood.drpc.org`.
  - Checked all 11 pairs on chain with `cast` at block ~111.48M.
  - Dry-ran `Deploy.s.sol` without `--broadcast`. Nothing was deployed and no transaction was sent. `src/` was not modified.

## Summary

| ID | Severity | Title |
|---|---|---|
| L-1 | Low | Fallback reason 1 reads `oraclePaused` *now*, not at the close. A later, unrelated pause can flip the outcome of an offer nobody has settled yet |
| L-2 | Low | `effectiveAt` is a single slot. When the issuer overwrites it, a corporate-action hold disappears and settle goes through on an affected close |
| L-3 | Low | ETH credited to an address that cannot receive ETH is locked forever (no `withdrawEthTo`) |
| L-4 | Low | Weekend buys are priced against Friday's print (4-day age), so standing quotes can be picked off on weekend news |
| L-5 | Low (Medium if $BRIM supply is very large) | BrimDrip `rewardPerToken` 1e18 precision: 1-wei `notify` pokes can floor a stream to zero for a large staked supply, and the ETH stays stuck |
| I-1 | Info | Round proof verified on the real feeds (DualAggregator): ids are consecutive, `updatedAt` is monotonic, aliases are rejected |
| I-2 | Info | `updatedAt == expiry` is the close (correct, tested) |
| I-3 | Info | After 30 days either path is open and the first caller decides (as documented) |
| I-4 | Info | Pooled per-token custody: `adminBurn`, blocking the vault, or pausing the token hits the last claimants (issuer trust) |
| I-5 | Info | `setToken`: no front-running is possible, but the deployer key is fully trusted and must not be lost |
| I-6 | Info | Event gaps for an indexer (BrimDrip `queued` changes silently, among others) |
| I-7 | Info | Deploy script and launch set verified. Notes on extra checks |
| I-8 | Info | Smaller notes: dead code, the SPEC holiday claim, fee pickup, the settlement price |

No Critical, High or Medium findings in the vault. I found no path that lets the vault owe more tokens or ETH than it holds, and no reentrancy path.

---

## Findings

### L-1: fallback reason 1 uses the current `oraclePaused`, so a late pause can flip an unsettled offer (Low)

**Location:** `BrimVault.settleFallback`, line 190 (`else if (_oraclePaused(o.token)) reason = 1;`).

**Scenario:**
1. TSLA's round r+1 normally prints on Monday at 01:00 UTC, so settle is possible from expiry + 52 h. Fallback opens at expiry + 96 h.
2. The writer of an **OTM** offer has to call `settle` within those ~44 h to collect the premium. Buyers of an OTM call prefer the fallback, which refunds their premium.
3. Suppose the writer does not settle in time, and at any moment after expiry + 4 d the issuer sets `oraclePaused`, for example while preparing an unrelated corporate action.
4. Then anyone can call `settleFallback` with reason 1. The buyer gets the full premium back and the writer loses it, even though a valid settlement existed the whole time.

The mirror case also exists: the writer of an **ITM** offer benefits if buyers have not settled.

SPEC A2 says "Each reason below makes settle revert under the same conditions, so the two paths cannot race". That holds at the instant of the call, but not over time.

**Proof:** `test/review/ReviewVault.t.sol::test_review_late_oracle_pause_flips_otm_outcome`.

**Fix:** this cannot be fixed fully, because historical `oraclePaused` is not readable. Mitigate operationally:
- run a keeper (or the web app) that calls `settle` for every expired Open offer as soon as r+1 exists;
- document that the favoured party must settle within ~2 days.

Optionally, accept reason 1 only if the pause is observed together with a proven close (pass `roundId` and require kind 1 for reason 1 too). This narrows the race but does not remove it.

### L-2: overwriting `effectiveAt` removes the corporate-action hold (Low)

**Location:** `BrimVault._issuerHold`, lines 307–313.

On chain, `effectiveAt()` holds the timestamp of the **latest** multiplier change. It persists after the change, for example NVDA 2026-09-10 00:00:30, SPY 2026-09-18 00:10:33 and AAPL 2026-08-14 15:12:46. The guard is evaluated at settle time.

**Scenario:**
1. A dividend multiplier change becomes effective 6 h before the close, so `settle` reverts with `IssuerHold`.
2. Before anyone calls the fallback (which opens at expiry + 4 d), the issuer schedules the next action, which overwrites `effectiveAt` with a future date.
3. The hold vanishes, and `settle` succeeds on the close that the first action straddled.

The reverse also happens: a new action that becomes effective within one day after expiry blocks a settle that was valid until then. The price impact of a dividend multiplier change is small (under ~1 %). A split is priced in raw-token units and should be continuous.

**Proof:** `test_review_effectiveAt_overwrite_unblocks_settle`.

**Fix:** accept the risk and document it. Alternatively, store a per-offer decision: anyone may "pin" the hold with an extra function that records `IssuerHold` the first time it is observed for an offer, after which only the fallback is allowed. A keeper settling or falling back promptly also reduces the risk.

### L-3: ETH credited to a non-receiving address is locked (Low)

**Location:** `BrimVault.withdrawEth`, lines 237–244, and `_pay`, lines 327–332.

**Scenario:**
1. A writer that is a contract without `receive()`/`fallback` (a custom vault or a minimal smart account) writes an offer and gets a premium credited at settle.
2. `withdrawEth(writer)` always pushes to `account` and reverts with `RefundFailed`.
3. There is no way to send the ETH elsewhere, so it is locked forever.

The same applies to a buyer contract whose fallback refund was credited.

**Proof:** `test_review_contract_without_receive_eth_locked`.

**Fix:** add `withdrawEthTo(address payable to)`, which pays `ethOwed[msg.sender]` to `to`. Keep `withdrawEth(account)` for the BrimDrip pickup.

### L-4: weekend pick-off of standing quotes (Low)

**Location:** `BrimVault.buy`, line 146 (`BUY_PRICE_AGE = 4 days`).

**Scenario:**
1. The feeds stop printing from Friday ~21:00 to Monday 01:00 UTC. The real TSLA rounds are 2025 on Fri 20:55:30 and 2026 on Mon 01:00:27.
2. On Sunday, a buyer who expects Monday to gap above the strike (on weekend news) buys calls for the following Friday. The "OTM" check passes against Friday's price, and the premium is the writer's standing price.
3. The writer's only defence is to cancel before the buy lands.

The anti pick-off check in SPEC is therefore weaker than its name suggests over weekends and holidays. During the week the gap is bounded by the 0.5 % deviation threshold.

**Proof:** `test_review_weekend_stale_buy`.

**Fix:** this is a design choice. Show a "quotes stay live over the weekend" warning in the UI. Optionally add a writer-chosen `maxPriceAge` per offer, or reject buys when `block.timestamp - upd > MAX_PRICE_AGE` unless the writer opts in.

### L-5: BrimDrip precision loss for a large staked supply, griefable with 1-wei pokes (Low; Medium if the $BRIM supply is ≥ ~1e28 raw units)

**Location:** `BrimDrip.rewardPerToken`, line 118, together with `_update` in every entry point, including `notify{value:1}`.

Each checkpoint floors `dt * rate * 1e18 / totalStaked`. The ETH lost per checkpoint is at most `totalStaked / 1e18` wei. That dust is neither re-queued nor recoverable, because there is no sweep.

At the minimum stream (0.005 ETH / 7 d ≈ 8.27e9 wei/s) and a poke every 60 s:

| Staked (raw) | Effect |
|---|---|
| 1e27 (1B tokens, 18 dec) | ≤ 0.2 % loss: negligible (`test_review_precision_typical_supply`) |
| 1e28 | ~2 % at 60 s, ~10 % at 12 s |
| 1e30 (1T tokens) | **stakers earn 0**: the entire stream is floored away (`test_review_precision_griefing_large_supply`: 178000000000000 wei without pokes, 0 with pokes) |

A 1-wei `notify` costs the griefer only gas, about 5e11 wei at 0.01 gwei. Ordinary usage also checkpoints often.

$BRIM is not launched yet, and BrimDrip is immutable and is wired as the immutable `feeRecipient`. If $BRIM turns out to have a huge supply, both contracts would have to be redeployed.

**Fix (one line):** scale by 1e36 instead of 1e18 in `rewardPerToken` and `earned`:
- `((t - lastUpdate) * rewardRate * 1e36) / totalStaked`
- `/ 1e36` in `earned`

There is no overflow risk at realistic rates. Alternatively, confirm before deploy that the $BRIM total supply is ≤ 1e9 tokens with 18 decimals.

### I-1: round proof verified on the real feeds (Info)

All 11 proxies point to a Chainlink `DualAggregator 1.0.0` (SVR) in phase 1. On the fork (`test/review/ReviewFork.t.sol::test_review_fork_round_semantics`), TSLA rounds 2015–2030 have:
- consecutive ids;
- monotonic `updatedAt`, which is the transmission time (`startedAt` is the observation time, about 12 s earlier).

The edge reads behave as the vault expects:

| Read | Result | Effect in the vault |
|---|---|---|
| Not-yet-printed round | Returns id `phase<<64` with zeros | `_round` returns (0,0), so the round is rejected |
| uint32-aliased id (`1<<32 + 2025`) | Returns a different id | Rejected |
| Round 0 | Echoes the id with zeros | Excluded by `agg == 0` |
| Unknown phase | Reverts | Caught by try/catch |

`test_review_fork_settle_rejects_alias_and_accepts_close` settles a real offer at `1<<64|2025` (358.256825) and rejects the aliased ids. Within a phase, OCR transmissions increment the round id by one, so round r+1 does prove that r is the last round. A phase change after expiry pushes the offer to the "new phase" fallback (reason 3), which is correct.

Uniqueness: because `updatedAt` is non-decreasing, exactly one round satisfies `upd ≤ E < next.upd`. Rounds that share a timestamp are handled: only the last one qualifies.

### I-2: `updatedAt == expiry` (Info)

A round printed exactly at expiry is the close, and a round at expiry + 1 proves it. This is consistent with `BUY_CUTOFF` (expiry − 2 h). **Proof:** `test_review_updatedAt_equal_expiry_is_close`.

### I-3: long-stop race (Info)

After `expiry + 30 d`, both `settle` (if provable) and `settleFallback` (reason 4) are open, and the first caller picks the outcome. This is documented in SPEC D. A keeper that settles promptly makes it moot.

### I-4: pooled custody and issuer powers (Info)

All offers on the same token share one vault balance. If the issuer `adminBurn`s the vault's balance, the last claimants cannot be paid. The same applies to a blocked vault, a paused token, or a beacon upgrade that changes transfer semantics. A blocked buyer or writer only blocks their own token leg; ETH legs are independent. That is tested, and I agree. A forced cash-out corporate action (a merger) would pay the vault address off chain. This is all issuer trust and should be disclosed in the UI.

### I-5: `setToken` authorization and front-running (Info)

Only the immutable `deployer` can call it, exactly once, and the token must have code. There is no front-running vector. However:
- the deployer can set a token it can mint freely and so capture every future fee;
- if the deployer key is lost before `setToken`, all fees queue forever with no recovery path.

In `Deploy.s.sol`, `deployer` is the broadcasting account. The dry run used Foundry's default sender, so confirm that the logged deployer equals your keystore address on the real run.

### I-6: event completeness (Info)

The vault emits an event for every state change. Notes for the indexer:
- `BuyerClaimed` has no `offerId`, so join through `Bought`.
- `FellBack` has no `roundId`.

In BrimDrip:
- `_update` moves idle accrual into `queued` without an event, for example inside `stake` while `totalStaked` is 0.
- `StreamStarted` does not include the new `queued` remainder.

An indexer must therefore read `queued()` instead of reconstructing it. Suggestion: emit `Queued(uint256 queued)` when it changes, or add `queued` to `StreamStarted`.

### I-7: deploy script and launch set (Info)

Verified on chain with `cast` at block ~111.48M:
- every token `symbol()` matches LaunchSet;
- every feed `description()` names the same ticker: RHNVDA, RHTSLA, Robinhood AAPL, RHSPY, Robinhood QQQ, RHMSFT, Robinhood AMZN, Robinhood GOOGL, GLD, Robinhood SPCX and Robinhood MSTR;
- every feed has `decimals()` 8 and `phaseId()` 1;
- `oraclePaused()` is false everywhere.

`test_review_fork_pairs_match` asserts that each description contains the symbol.

The dry run (`forge script script/Deploy.s.sol --rpc-url https://robinhood.drpc.org`, no broadcast) succeeds:
- wiring `feeRecipient == BrimDrip` and `feeBps == 100`;
- about 4.39M gas, about 0.00018 ETH.

`abi/*.json` matches the current build.

Suggested additions to the script:
- assert `phaseId() == 1` and `!oraclePaused()` for each pair;
- assert that the description contains the symbol (it is only logged);
- when `TOKENS` is overridden, require that `FEEDS` is set too (today `vm.envAddress("FEEDS")` reverts, which is acceptable).

### I-8: smaller notes (Info)

- **Dead code.** In `BrimDrip.canKick()`, the `totalStaked == 0` idle branch is dead, because the function then returns false anyway.
- **SPEC A4/D holiday claim.** SPEC says a Friday holiday is refunded. That only happens if the last print is more than 26 h before Fri 21:00 UTC. With a late Thursday print (24/5 sessions), the offer settles at Thursday's last price. Christmas 2026 (Friday 25-12) depends on the time of the Thursday half-day print.
- **Settlement price.** The close is the last Chainlink print and can lag the true close by up to the 0.5 % deviation threshold; SPY's close on 30 Oct was 3 h old. During US daylight saving time, 21:00 UTC falls in after-hours trading.
- **Fee pickup.** Fees sit in the vault until somebody calls `withdrawEth(BrimDrip)`. Have the keeper or the web app call it.
- **Precision in the vault.** Rounding is safe:
  - `Σ floor(aᵢ(P−K)/P) ≤ floor(sold(P−K)/P)`;
  - `fee + toWriter == escrow`;
  - fallback refunds sum to `escrow`;
  - `cancel` after settle and before `claimWriter` stays consistent, because `claimWriter` uses the reduced `available`.
- **Reentrancy.** Every external mutator in both contracts is `nonReentrant`, and state is written before every external call. The drip's `receive` → `_notify` is guarded too. Reentering during a drip `claim` into `vault.withdrawEth(drip)` simply reverts and can be retried.
- **Gas/DoS.** The only loop is in the constructor. Returndata bombs from a malicious recipient only affect that recipient's own claim.
- **Test note.** Under `via_ir`, reading `block.timestamp` directly in a test function after `vm.warp` returns a stale value. `skip()` is fine, so the existing tests are not affected; I hit this only while writing the review tests.

---

## Review tests added (`test/review/`)

| File | Test | Finding |
|---|---|---|
| ReviewVault.t.sol | `test_review_late_oracle_pause_flips_otm_outcome` | L-1 |
| ReviewVault.t.sol | `test_review_effectiveAt_overwrite_unblocks_settle` | L-2 |
| ReviewVault.t.sol | `test_review_contract_without_receive_eth_locked` | L-3 |
| ReviewVault.t.sol | `test_review_weekend_stale_buy` | L-4 |
| ReviewVault.t.sol | `test_review_updatedAt_equal_expiry_is_close` | I-2 |
| ReviewDrip.t.sol | `test_review_precision_griefing_large_supply`, `test_review_precision_typical_supply` | L-5 |
| ReviewFork.t.sol | `test_review_fork_round_semantics`, `test_review_fork_settle_rejects_alias_and_accepts_close`, `test_review_fork_pairs_match` | I-1, I-7 |

`forge test`: **76 passed, 0 failed** (66 original + 10 review).

## Verdict

**OK to deploy after fix L-5**: change BrimDrip's `rewardPerToken` scale to 1e36. This is a one-line change; re-run the tests afterwards.

- Fix L-5 before deploy because BrimDrip and the vault's `feeRecipient` are immutable and $BRIM's supply is not known yet.
- **Exception:** if you confirm before tonight that the $BRIM total supply is ≤ 1e9 tokens (18 decimals), L-5 is negligible and the contracts are **OK to deploy as is**.
- **L-3** (`withdrawEthTo`) is recommended but optional.
- **L-1, L-2 and L-4** need operational mitigation, not code changes:
  - a keeper that settles every expired offer as soon as r+1 prints and that calls `withdrawEth(BrimDrip)`;
  - UI disclosures for weekend quotes and issuer powers.

## Post-review fixes (applied by lead, 11-11-2026)
- **L-5 fixed**: BrimDrip `rewardPerToken` scale 1e18 → 1e36 (lines 29/118/123). `test_review_precision_griefing_large_supply` now asserts the griefed payout stays > 99.9 % of the honest one.
- **L-3 fixed**: BrimVault `withdrawEthTo(address to)`: the credited account pulls its own ETH to another address. Covered in `test_review_contract_without_receive_eth_locked`.
- L-1, L-2, L-4: handled operationally (keeper settles each offer as soon as round r+1 exists and calls `withdrawEth(BrimDrip)`; UI warns about weekend quotes and issuer powers).
- I-6 (event gaps) not changed; the web reads state per item.
- `forge test`: 76/76 passing after the fixes (incl. fork + review tests).

**Final verdict: OK to deploy** (with L-3 and L-5 applied).
