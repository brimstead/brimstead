# BrimVault + BrimDrip — specification (as built)

Project #238, Robinhood Chain mainnet (chain id 4663, Arbitrum Orbit, gas in ETH).
**Unaudited.** Internal tests only; an independent review is pending. Nothing has been deployed.

```
src/BrimVault.sol        covered-call vault (no proxy, no owner)
src/BrimDrip.sol         $BRIM staking: streams every ETH it receives to stakers over 7 days (no owner powers over funds)
script/LaunchSet.sol     the 11 verified (stock token, Chainlink proxy) pairs
script/Deploy.s.sol      BrimDrip, then BrimVault(feeRecipient = BrimDrip, feeBps = 100 by default)
abi/BrimVault.json       ABI for the web (forge inspect ... abi --json)
abi/BrimDrip.json
test/BrimVault.t.sol     vault unit + fuzz (mocks in test/mocks/Mocks.sol)
test/BrimDrip.t.sol      drip unit + fuzz, plus the vault -> drip fee path
test/Fork.t.sol          RC mainnet fork: real tokens, real feeds, real Friday close rounds, a real BrimDrip as fee sink
```

# Part A — BrimVault

## A1. What it is
A covered-call market for Robinhood's tokenized stocks. A **writer** locks stock tokens and sells the upside above a
strike `K` for an ETH premium. **Buyers** pay the premium, which is held in escrow until the offer resolves. Every
call is fully collateralized. There is no borrowing and no liquidation. A writer's tokens only ever go (a) back to the
writer or (b) to buyers as their in-the-money share at expiry.

```
write ──► buy (partial, many; only while OTM) ──► [Fri 21:00 UTC] ──► settle (Friday close) ──► claims
  │                                                               └─► settleFallback        ──► claims
  └── cancel (unsold part, any time)
```

## A2. Functions

### Constructor `(address[] tokens, address[] feeds, uint256 feeBps, address feeRecipient)`
- Both arrays have equal length. Every token and feed has code. No duplicate token. `feed.decimals() != 0`.
- `feeBps <= 100`. `feeRecipient != 0`. Everything is immutable; there is no owner and no admin. The deploy script
  sets `feeRecipient` to BrimDrip.
- Emits `Listed(token, feed)` for each pair.

### `write(token, amount, strike, expiry, premiumPerToken) → offerId`
- `token` must be listed and `amount > 0`.
- **Expiry grid.** `expiry % 1 weeks == 45 h` (Friday 21:00 UTC), and `now + 1 day <= expiry <= now + 28 days`.
- **Price.** `latestRoundData()` must have `answer > 0`, `updatedAt <= now`, `now − updatedAt <= 26 h`, and the
  token's `oraclePaused()` must not be set. Otherwise it reverts with `BadPrice`. Writes therefore pause over
  weekends; the UI shows "market closed".
- **Strike.** `strike > answer`, strictly (feed units: USD per raw token, 8 decimals). An ATM write reverts with
  `BadStrike`, so every offer can be bought at the write-time price.
- **Pull.** `safeTransferFrom`. The balance delta must equal `amount`, otherwise it reverts with `FeeOnTransfer`.
- `premiumPerToken` is wei per 1e18 raw units. Zero is allowed.
- Emits `Written`.

### `buy(offerId, amount, maxPremium) payable → positionId`
- `now + 2 h < expiry` (buying is closed at exactly expiry − 2 h). `0 < amount <= available`.
- **Anti pick-off.** `latestRoundData()` must have `answer > 0`, `updatedAt <= now`, `now − updatedAt <= 4 days`,
  and `oraclePaused()` must not be set (otherwise `BadPrice`). The price must be strictly below the strike
  (`answer >= strike` reverts with `InTheMoney`). The 4-day age keeps buys working over a weekend for a later-week
  expiry, because Friday's print is still the current price then. Because `write` requires `strike > price`, every
  offer can be bought until the price rises to the strike.
- `premium = ceil(amount × premiumPerToken / 1e18)`. It must satisfy `premium <= maxPremium` and
  `premium <= msg.value`, otherwise it reverts with `PremiumTooHigh(premium)`.
- State: `available −= amount`, `sold += amount`, `escrow += premium`, and a new `Position` is created (not
  transferable).
- The excess `msg.value` is refunded in the same call. If that refund fails, the whole buy reverts (`RefundFailed`).
- Emits `Bought`.

### `cancel(offerId, amount)`
Writer only, at any time, for `0 < amount <= available`. It returns unsold tokens immediately. Sold collateral can
never be cancelled. Emits `Cancelled`.

### `settle(offerId, roundId)` — anyone, `now >= expiry`, offer Open. **Settlement is the Friday close.**
Proxy ids are `phaseId << 64 | n`. Round `r = roundId` is accepted only if **all** of these hold:
1. `r >> 64 == feed.phaseId()` (the current phase), and `1 <= n < 2^64 − 1`;
2. `getRoundData(r)` returns `r`, with `answer > 0` and `0 < updatedAt <= expiry`;
3. `getRoundData(r + 1)` (same phase) exists with `updatedAt > expiry`. This proves `r` is the **last** round at or
   before expiry;
4. `r.updatedAt >= expiry − 26 h` (the close is fresh). Otherwise the offer can only fall back, for example on a
   market-holiday Friday;
5. no issuer hold: `oraclePaused()` is false, and the token's `effectiveAt()` (a scheduled `uiMultiplier` change) is
   not in `(r.updatedAt − 1 day, expiry + 1 day)`.

Settle becomes possible as soon as `r + 1` exists. That is usually minutes after 21:00 UTC, because after-hours
prints continue; failing that, it is the Monday reopen. There is no deadline on `r + 1`: if it prints late, and nobody
proved its absence with the fallback first, settlement is still valid.

Payout with `P = r.answer`:
- the escrowed premium goes to the writer minus `fee = floor(escrow × feeBps / 10000)`, and the fee goes to
  `feeRecipient`. Both are credited to `ethOwed`; settle makes no external call;
- if `P > K`, each position receives `floor(amount × (P − K) / P)` tokens, and the writer receives
  `sold − floor(sold × (P − K) / P)` plus the unsold remainder;
- otherwise everything goes back to the writer.

Emits `Settled(offerId, roundId, price, writerEth, fee)`.

### `settleFallback(offerId, roundId)` — anyone, `now >= expiry + 4 days`, offer Open
It succeeds only when settlement is provably impossible at that moment. Each reason below makes `settle` revert under
the same conditions, so the two paths cannot race, except for reason 4:

| Reason | Condition | Why settle is impossible |
|---|---|---|
| 1 issuer | `oraclePaused()` is true, or `roundId` is the proven close but `effectiveAt` falls in the window of step 5 | step 5 |
| 2 no print after expiry | `latestRoundData().updatedAt <= expiry` | no `r + 1` with `updatedAt > expiry` exists in the current phase |
| 3 stale close | `roundId` is the proven close (steps 1–3) but `updatedAt < expiry − 26 h` | step 4 |
| 3 new phase | `roundId` is round 1 of the current phase and `updatedAt > expiry` | every round in the current phase is after expiry, so there is no in-phase close |
| 4 long stop | `now >= expiry + 30 days` | none required: the unconditional escape (a reverting feed, a round gap, a vanished proxy) |

Anything else reverts with `NotEligible`. Effect: status becomes FellBack. Buyers can claim the **full premium, with
no fee**, and the writer can claim **all** tokens. Emits `FellBack(offerId, reason)`. The 4-day wait leaves room for
`r + 1` on a Monday-holiday weekend: Friday → Tuesday 01:00 UTC is about 76 h.

### Claims (pull; anyone may call them, and funds go only to the rightful party)
- `claimBuyer(positionId)`: if Settled, it transfers the ITM tokens. If FellBack, it sends the premium (a direct call,
  credited to `ethOwed` if the call fails).
- `claimWriter(offerId)`: transfers the writer's remaining tokens.
- `withdrawEth(account)`: pays `ethOwed[account]`. BrimDrip receives the fee this way; anyone can trigger it.

Buyer and writer claims are independent: a blocked or paused transfer on one side never blocks the other side. ETH
never waits on a token transfer.

### Views and events
Views: `offer`, `position`, `offerCount`, `positionCount`, `tokens(i)`, `tokenCount`, `feedOf`, `ethOwed`,
`payoutOf`, the constants, `feeBps` and `feeRecipient`.

Events: `Listed`, `Written`, `Bought`, `Cancelled`, `Settled`, `FellBack`, `BuyerClaimed`, `WriterClaimed`,
`EthCredited` and `EthPaid`. Every state change emits at least one of them.

## A3. Constants
| Name | Value | Use |
|---|---|---|
| `MAX_FEE_BPS` | 100 | fee cap (the deploy default is 100 = 1 % of the premium) |
| `MAX_PRICE_AGE` | 26 h | `write` freshness |
| `BUY_PRICE_AGE` | 4 days | `buy` anti pick-off freshness (works over a weekend) |
| `CLOSE_MAX_AGE` | 26 h | the close round must be at least `expiry − 26 h` |
| `GRID_OFFSET` | 45 h | Friday 21:00 UTC |
| `MIN_TENOR` / `MAX_TENOR` | 1 / 28 days | |
| `BUY_CUTOFF` | 2 h | |
| `SETTLE_WINDOW` | 4 days | earliest fallback |
| `LONG_STOP` | 30 days | unconditional fallback |
| `ACTION_MARGIN` | 1 day | corporate-action guard |

## A4. Design decisions (and the history behind them)
- **Friday close (the last round at or before expiry).** This replaced the earlier "first round after expiry" model
  at the user's request. Measured on RC: the first print after Fri 21:00 UTC is usually Monday 01:00 UTC, about 52 h
  later, so that model priced the weekend gap. With the close model, a Friday holiday (no print within 26 h before
  21:00 UTC) is refunded via fallback reason 3 instead of settling at Thursday's price.
- **Fallback needs proof**, so that once 4 days have passed, a writer whose call is in the money cannot pre-empt a
  valid settle. The 30-day long stop guarantees liveness.
- **Issuer guards.** The feeds price USD per raw token (share price × `uiMultiplier`, established by #231 on a fork).
  A split or dividend whose multiplier change lands near the close could misprice settlement, so it falls back.
  Tokens without these views (reverting or missing) are treated as "no hold".
- **Anti pick-off on buy.** No `reprice` function. Writers who want a new premium cancel and write again.
- **Other choices:**
  - `cancel` takes an amount;
  - `claimWriter` also returns unsold tokens;
  - premium and fee are credited rather than pushed;
  - fallback refunds are pushed, with a credit if the push fails;
  - SGOV is left out of the launch set.

## A5. Accounting invariants (tested, including fuzz)
- **Tokens per offer.** The total owed is `Σ floor(aᵢ·(P−K)/P) + sold − floor(sold·(P−K)/P) ≤ sold`, so the vault
  never owes more than it holds. Dust is less than 1 wei per position and stays in the vault (there is no sweep).
- **ETH.** `Σ premiums = escrow`. On settle, `writer + fee = escrow`. On fallback, `Σ refunds = escrow`. Excess
  `msg.value` is returned. There is no `receive`, so plain ETH transfers to the vault revert.
- Offers on the same token are isolated from each other.

# Part B — BrimDrip

## B1. What it is
Stake $BRIM and earn ETH. **Every wei of ETH sent to BrimDrip** is streamed linearly to stakers over 7 days, pro rata
to stake, using Synthetix-style `rewardRate` / `rewardPerToken`. That includes BrimVault fees (paid by
`withdrawEth(drip)`), the user's manual transfers of Pons creator fees, and anyone's `notify()`. Incoming ETH first
goes to `queued`. A new 7-day stream (`leftover + queued`) starts only when `queued >= MIN_RESTART` (0.005 ETH),
somebody is staked, and the token is set. This stops dust from pushing the end date back.

## B2. Functions
- `constructor()`: records `deployer = msg.sender` (immutable). There is no owner.
- `setToken(address)`: only `deployer`, **exactly once**, and the token must have code. Then it is locked
  (`TokenAlreadySet`). This is the deployer's only power; it has no access to funds. Emits `TokenSet`.
- `receive()` / `notify() payable`: these require `msg.value > 0`. They accrue the stream and add the ETH to `queued`
  (emitting `Notified`). Then, **if `queued >= MIN_RESTART`, `totalStaked > 0` and the token is set**, they start a
  new stream: `rewardRate = (leftover of the current stream + queued) / 7 days`, `periodFinish = now + 7 days`, and
  the division remainder stays in `queued` (emitting `StreamStarted`). Otherwise the ETH waits and the running stream
  is untouched. Plain ETH transfers work (they cost tens of thousands of gas, so a 2300-gas `transfer()`/`send()`
  from a contract would fail).
- `kick()`: anyone. It starts the stream under the same condition, and reverts with `NotReady` otherwise. It is needed
  after the **first stake** following `setToken` (or following a period with no stakers), because `stake` does not
  start a stream itself. It is also needed whenever the condition becomes true without a payment. `canKick()` is the
  matching view, for the web app.
- `stake(amount)`: requires the token to be set and `amount > 0`. The balance delta must equal `amount`, otherwise it
  reverts with `FeeOnTransfer`. A running stream continues at its rate, and the new staker shares it from now.
  `stake` never starts or restarts a stream (`kick` does). Emits `Staked`.
- `unstake(amount)`: at any time, up to the caller's balance. Rewards earned so far stay claimable. Emits `Unstaked`.
- `claim()`: pull. It pays `earned(msg.sender)` by `call` and reverts if the send fails. Emits `Claimed`.
- Views: `earned`, `rewardPerToken`, `lastTimeRewardApplicable`, `pending()` (stream left + queued + idle accrual),
  `canKick()`, `queued`, `rewardRate`, `periodFinish`, `totalStaked`, `balanceOf`, `token`, `deployer`, `DURATION`
  and `MIN_RESTART`.
- Every mutating entry point is `nonReentrant`, including `receive`/`notify`.

## B3. Zero stakers: no ETH is lost
- When total staked is 0, the time-based accrual is not given to anybody. On every update, the elapsed part of the
  stream (`rate × elapsed`, capped at `periodFinish`) is moved into `queued`. Once someone stakes, that ETH starts
  streaming at the next `kick()` (or at the next payment that meets the condition), over a fresh 7 days together with
  the leftover.
- ETH received before `setToken` sits in `queued`. It starts with `kick()` after the first stake.
- `queued` below `MIN_RESTART` waits, whether or not there are stakers. It is never lost, only delayed until more ETH
  arrives.
- **Invariant (fuzz-tested):** `balance >= Σ earned + pending`, and the difference is rounding dust only (under 1e9 wei
  in the fuzz runs; the fuzz mixes sub-threshold payments, stakes, unstakes, claims and kicks). After the stream ends
  and everyone claims, only `queued` and rounding dust remain. `queued` is then either below `MIN_RESTART` or the
  restart remainder (at most 604,799 wei).

## B4. Drip trust assumptions and limits
- No owner, no admin, no proxy, no sweep. The deployer's only power is the one-shot `setToken`. If the deployer sets
  the wrong token, nothing can fix it: deploy a new BrimDrip, and since BrimVault's `feeRecipient` is immutable, a new
  BrimVault as well. **Check the address twice.**
- **Restart griefing is bounded.** A restart needs at least 0.005 ETH of new queued ETH, and that ETH goes to stakers.
  Pushing the end date back by 7 days therefore costs the griefer at least 0.005 ETH each time. Dust (for example
  200 notifies of 1 wei) leaves the end date unchanged, which is tested.
- If total fee income stays below 0.005 ETH, it waits in `queued` until the total crosses the threshold.
- `rewardPerToken` has 1e18 precision. With a very large `totalStaked`, each update can floor away up to
  `totalStaked / 1e18` wei. That is negligible, and the dust stays in the contract.
- ETH forced in by `selfdestruct` is not accounted, so it stays stuck. $BRIM must be a standard ERC-20; rebasing
  tokens are not supported.

# Part C — Trust assumptions (vault)
- **Robinhood (issuer)** can pause tokens, block any address (including the vault), `adminBurn` the vault's balance,
  upgrade the token logic, schedule `uiMultiplier` changes, and set `oraclePaused`:
  - a blocked buyer or writer only blocks that side's token claim, and ETH still flows;
  - a blocked vault or a paused token stops all token flows of that token until it is lifted;
  - `adminBurn` makes the last claimants of that token unable to claim;
  - a beacon upgrade could change transfer semantics (the balance-delta check only runs in `write`).
- **Chainlink**: the answer is trusted. The proxy's phase semantics are trusted: a missing in-phase round reads as
  zeros and an unknown phase reverts (verified on RC by #177). `updatedAt` is assumed monotonic within a phase.
- **Sequencer**: there is no uptime check. An outage delays settle and claims; it does not change which round is the
  close.
- **No admin**: the registry is fixed. A dead feed or a new stock means a new deployment.

# Part D — Known limits (for the docs page)
- Settlement is the Friday close **as last printed by Chainlink** (0.5 % deviation / 24 h heartbeat). It can be up to
  26 h old and can lag the true close by up to about 0.5 %.
- Writes need a print younger than 26 h ("market closed" on weekends and US holidays). Buys need one younger than
  4 days and below the strike.
- A Friday holiday, or a corporate action near the close, means a full refund (fallback).
- A round gap right after the close can only be resolved by the 30-day long stop.
- After 30 days either path is open, and whoever calls first decides.
- Positions are not transferable.

# Part E — What is unaudited
Everything. In particular:
- the last-before round proof and the fallback eligibility table;
- the corporate-action window;
- the anti pick-off check and the strict-OTM write rule;
- the rounding argument;
- BrimDrip's zero-staker accounting, the MIN_RESTART/kick logic and the restart math;
- the issuer-behaviour assumptions (blocked and paused tokens were tested with mocks, and on the fork with a mocked
  registry `isBlocked`).

There is no formal verification. The fuzz tests are function-level fuzz tests with random operation sequences, not
forge invariant campaigns.

# Part F — Tests
`forge test` runs **66 tests: BrimVault 42, BrimDrip 16, fork 8**, with 1000 fuzz runs per fuzz test. The fork
defaults are `FORK_RPC=https://robinhood.drpc.org` (an archive node) and `FORK_BLOCK=111464891`. publicnode prunes
state after about 100 blocks and fails partway through a fork run. `SKIP_FORK=1` makes the fork tests return early;
they then pass without testing anything.

Fork tests on real data:
- **TSLA ITM**: settles at the real close `1<<64|2025` (Fri 06 Nov 20:55:30 UTC, 358.256825), proven by
  `|2026` (Mon 01:00:27). `|2024` and `|2026` are rejected. The 1 % fee reaches a real BrimDrip through `receive()`
  and is queued.
- **SPY OTM**: settles at the close `|191` (Fri 30 Oct 18:01:49), proven by the after-hours `|192`. `|190` and `|192`
  are rejected.
- **Stale close**: with the expiry moved to Sunday, the close `|2025` is 48 h old, so settle reverts and the fallback
  succeeds with reason 3.
- **Real stale feed**: fallback reason 2.
- **Strike rules on the real TSLA feed**: an ATM write is rejected (`BadStrike`); a write at price + 1 is accepted and
  buyable; with the strike forced to the live price, a buy is rejected (`InTheMoney`).
- **Blocked buyer**: isolated from the writer.
- **Launch set**: verified on chain.
- **All 11 tokens**: pass the balance-delta write check.

The fork tests use a test-only harness (`BrimVaultHarness`) that moves an offer's expiry and strike into the past.

# Part G — Launch set (verified 11-11-2026 with cast)
All tokens have 18 decimals and `paused() == oraclePaused() == false`. All feeds have 8 decimals and are in phase 1.

| Symbol | Token | Chainlink proxy | description() |
|---|---|---|---|
| NVDA | 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC | 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 | RHNVDA / USD |
| TSLA | 0x322F0929c4625eD5bAd873c95208D54E1c003b2d | 0x4A1166a659A55625345e9515b32adECea5547C38 | RHTSLA / USD |
| AAPL | 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9 | 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0 | Robinhood AAPL / USD |
| SPY | 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C | 0x319724394D3A0e3669269846abE664Cd621f9f6A | RHSPY / USD |
| QQQ | 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68 | 0x80901d846d5D7B030F26B480776EE3b29374C2ae | Robinhood QQQ / USD |
| MSFT | 0xe93237C50D904957Cf27E7B1133b510C669c2e74 | 0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E | RHMSFT / USD |
| AMZN | 0x12f190a9F9d7D37a250758b26824B97CE941bF54 | 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C | Robinhood AMZN / USD |
| GOOGL | 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3 | 0xF6f373a037c30F0e5010d854385cA89185AE638b | Robinhood GOOGL / USD |
| GLD | 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e | 0x470A51258068043bd43dC0a56245625C9fE86eB0 | GLD / USD |
| SPCX | 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa | 0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb | Robinhood SPCX / USD |
| MSTR | 0xec262a75e413fAfD0dF80480274532C79D42da09 | 0x396118bdFB181e6240E74D243F266B061c0edc3D | Robinhood MSTR / USD |

Excluded: SGOV (a T-bill ETF with heartbeat-only prints).

# Part H — Deploy (humans only; not run)
```sh
forge script script/Deploy.s.sol --rpc-url mainnet_archive                                   # dry run
forge script script/Deploy.s.sol --rpc-url mainnet --broadcast --account <keystore>          # FEE_BPS default 100
# after the $BRIM launch, from the SAME account:  cast send <BrimDrip> "setToken(address)" <BRIM>
# after the first stake (anyone; the web app can do it):  cast send <BrimDrip> "kick()"   (when canKick() is true)
```
The script checks the chain id (4663), the token decimals (18), the feed decimals (8) and a live answer for each feed.
It deploys BrimDrip first, then BrimVault with `feeRecipient = BrimDrip`, and asserts the wiring. Runtime sizes:
BrimVault 7.9 KB, BrimDrip 3.7 KB. After any ABI change, re-export with:
`forge inspect src/BrimVault.sol:BrimVault abi --json > abi/BrimVault.json` (and the same for BrimDrip).
