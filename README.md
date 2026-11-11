# Brimstead

**Keep your stock. Sell the brim.**

Covered calls for Robinhood's tokenized stocks on Robinhood Chain (chain id 4663).
Live at **https://brimstead.xyz** · X [@brimsteadxyz](https://x.com/brimsteadxyz)

## How it works

1. A holder locks stock tokens in **BrimVault**, picks a strike above the live Chainlink price and a Friday 21:00 UTC expiry, and sets a premium in ETH.
2. Buyers pay the premium for the upside above the strike. The premium is held in escrow until settlement. Buying closes 2 hours before expiry and is refused once the live price is at or above the strike.
3. At expiry the vault settles on the last Chainlink round at or before Friday 21:00 UTC (proven by the next round).
   - Close **P** above strike **K**: the buyer receives `amount × (P − K) / P` tokens; the writer keeps the rest.
   - Otherwise the writer keeps all tokens.
   - The writer receives the premium minus a 1% protocol fee.
4. If no valid close can exist (feed paused or stale, corporate action at expiry), both sides get a full refund. There is also an unconditional escape after 30 days.

There is no borrowing and no liquidation. Shares never leave the vault except to pay a buyer's in-the-money share.

The 1% fee goes to **BrimDrip**, which streams received ETH linearly over 7 days to $BRIM stakers.

## Contracts (Robinhood Chain mainnet, source verified on Sourcify)

| Contract | Address |
|---|---|
| BrimVault | [`0x9599EA610B86d196A2F3E7a476735F9AA5622ABc`](https://robinhoodchain.blockscout.com/address/0x9599EA610B86d196A2F3E7a476735F9AA5622ABc) |
| BrimDrip | [`0x415E708435CA74a013b7E9E18B0C3fA79A61D429`](https://robinhoodchain.blockscout.com/address/0x415E708435CA74a013b7E9E18B0C3fA79A61D429) |

No proxy, no owner, no admin withdraw. The deployer's only power is `BrimDrip.setToken`, callable once.

## Repository

- `contracts/`: Solidity sources, tests (unit, fuzz, mainnet-fork, review), deploy script, [`SPEC.md`](contracts/SPEC.md), [`REVIEW.md`](contracts/REVIEW.md)
- `web/`: the static site and app (three.js + GSAP, no build step)
- `keeper/`: the keeper that settles expired offers, moves vault fees to BrimDrip and starts streams

### Run the tests

```sh
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
forge test
```

Fork tests need an archive RPC for chain 4663; set `SKIP_FORK=1` to skip them.

## Status and risks

The contracts had an independent review: no critical, high or medium findings. This is not a formal audit. Read [`contracts/REVIEW.md`](contracts/REVIEW.md) and the risks page at https://brimstead.xyz/risks/ before using it.

Stock tokens are issued by Robinhood, which can pause, block or burn them. Chainlink equity feeds update 24/5.

No promised returns.

## License

MIT
