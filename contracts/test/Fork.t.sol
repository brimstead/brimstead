// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BrimVault, IFeed} from "../src/BrimVault.sol";
import {BrimDrip} from "../src/BrimDrip.sol";
import {LaunchSet} from "../script/LaunchSet.sol";

interface IStockFull {
    function paused() external view returns (bool);
    function oraclePaused() external view returns (bool);
    function uiMultiplier() external view returns (uint256);
}

interface IRegistry {
    function isBlocked(address) external view returns (bool);
}

interface IFeedDesc {
    function description() external view returns (string memory);
}

/// Test-only hooks: move an offer's expiry into the past (and set a strike) so settlement can be proven against REAL historical rounds.
contract BrimVaultHarness is BrimVault {
    constructor(address[] memory t, address[] memory f, uint256 b, address r) BrimVault(t, f, b, r) {}

    function forceExpiry(uint256 id, uint64 e) external {
        _offers[id].expiry = e;
    }

    function forceStrike(uint256 id, uint256 k) external {
        _offers[id].strike = k;
    }
}

/// Robinhood Chain mainnet fork (real stock tokens, real Chainlink proxies):
///   forge test --match-path test/Fork.t.sol -vv     (FORK_RPC default https://robinhood.drpc.org = archive,
///                                                    FORK_BLOCK default 111464891)
///   SKIP_FORK=1 forge test                           (offline: these tests return early)
/// publicnode prunes state after ~100 blocks (seconds on RC), so it fails mid-run on a fork; use an archive RPC.
contract ForkTest is Test {
    address constant REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    // Real rounds (phase 1), read with cast on 11-11-2026:
    //   TSLA agg 2024  (earlier Friday print)
    //   TSLA agg 2025  Fri 06 Nov 20:55:30 UTC  358.25682500   <- the Friday close: last print <= Fri 06 Nov 21:00 UTC
    //   TSLA agg 2026  Mon 09 Nov 01:00:27 UTC  358.27292797   <- round + 1 (> expiry) proves it
    //   SPY  agg 191   Fri 30 Oct 18:01:49 UTC  754.59416276   <- the close for Fri 30 Oct 21:00 UTC (3 h old)
    //   SPY  agg 192   Sat 31 Oct 00:00:25 UTC  758.37790204   <- after-hours print = round + 1
    uint80 constant PH = uint80(1) << 64;
    uint256 constant FORK_BLOCK = 111_464_891; // Wed 11 Nov 2026 ~05:28 UTC
    uint64 constant FRI_06_NOV = 1_793_998_800;
    uint64 constant FRI_30_OCT = 1_793_394_000;

    bool noFork;
    BrimVaultHarness v;
    BrimDrip drip;
    address feeTo;
    address writer = makeAddr("writer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    string[] sym;
    address[] tok;
    address[] fd;

    function setUp() public {
        if (vm.envOr("SKIP_FORK", false)) {
            noFork = true;
            return;
        }
        vm.createSelectFork(vm.envOr("FORK_RPC", string("https://robinhood.drpc.org")), vm.envOr("FORK_BLOCK", FORK_BLOCK));
        (sym, tok, fd) = LaunchSet.list();
        drip = new BrimDrip();
        feeTo = address(drip);
        v = new BrimVaultHarness(tok, fd, 100, feeTo);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function _nextExpiry() internal view returns (uint64 e) {
        uint256 t = block.timestamp + 1 days;
        e = uint64(t - (t % 1 weeks) + 45 hours);
        if (e < t) e += 1 weeks;
    }

    /// Make the feed "fresh" for write() even if the fork runs on a weekend: warp to just after the last print.
    function _freshen(address feed) internal returns (uint256 px) {
        (, int256 a,, uint256 upd,) = IFeed(feed).latestRoundData();
        if (block.timestamp > upd + 20 hours) vm.warp(upd + 1 hours);
        return uint256(a);
    }

    function _writeReal(address token, address feed, uint256 amt, uint256 strikeBps) internal returns (uint256 id) {
        uint256 px = _freshen(feed);
        deal(token, writer, amt);
        vm.startPrank(writer);
        IERC20(token).approve(address(v), amt);
        id = v.write(token, amt, (px * strikeBps) / 10_000, _nextExpiry(), 0.002 ether);
        vm.stopPrank();
    }

    function test_fork_launch_set_verified() public view {
        if (noFork) return;
        assertEq(block.chainid, 4663);
        assertFalse(IRegistry(REGISTRY).isBlocked(address(v)), "vault blocked");
        for (uint256 i; i < tok.length; ++i) {
            assertEq(IERC20Metadata(tok[i]).symbol(), sym[i]);
            assertEq(IERC20Metadata(tok[i]).decimals(), 18, sym[i]);
            assertFalse(IStockFull(tok[i]).paused(), sym[i]);
            assertFalse(IStockFull(tok[i]).oraclePaused(), sym[i]);
            assertEq(IFeed(fd[i]).decimals(), 8, sym[i]);
            assertEq(IFeed(fd[i]).phaseId(), 1, sym[i]);
            (uint80 rid, int256 a,, uint256 upd,) = IFeed(fd[i]).latestRoundData();
            assertGt(a, 0, sym[i]);
            assertEq(rid >> 64, 1, sym[i]);
            assertEq(v.feedOf(tok[i]), fd[i]);
            console.log(sym[i], IFeedDesc(fd[i]).description(), uint256(a), (block.timestamp - upd) / 60);
        }
        assertEq(v.tokenCount(), 11);
    }

    /// Full ITM flow with real TSLA: write 1 % OTM at the live price, two buys, then settle at the real Friday close
    /// of Fri 06 Nov 21:00 UTC (agg 2025, 20:55:30 UTC, proven by agg 2026). The 1 % fee lands in a real BrimDrip.
    function test_fork_tsla_settle_real_round() public {
        if (noFork) return;
        uint256 id = _writeReal(TSLA, TSLA_FEED, 10e18, 10_100); // 1 % OTM at the live price
        vm.prank(alice);
        uint256 p1 = v.buy{value: 1 ether}(id, 4e18, 0.008 ether);
        vm.prank(bob);
        uint256 p2 = v.buy{value: 0.002 ether}(id, 1e18, 0.002 ether);
        assertEq(alice.balance, 10 ether - 0.008 ether);
        assertEq(address(v).balance, 0.01 ether);
        vm.prank(writer);
        v.cancel(id, 2e18); // unsold back at once
        assertEq(IERC20(TSLA).balanceOf(writer), 2e18);

        v.forceExpiry(id, FRI_06_NOV);
        uint256 strike = 350e8; // pretend strike to exercise the ITM path on the real print
        v.forceStrike(id, strike);
        assertEq(v.offer(id).strike, strike);

        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, PH | 2024); // not the last before expiry
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, PH | 2026); // after expiry
        v.settle(id, PH | 2025);
        uint256 P = v.offer(id).price;
        assertEq(P, 35825682500);

        v.claimBuyer(p1);
        v.claimBuyer(p2);
        v.claimWriter(id);
        uint256 a4 = (4e18 * (P - strike)) / P;
        uint256 b1 = (1e18 * (P - strike)) / P;
        assertEq(IERC20(TSLA).balanceOf(alice), a4);
        assertEq(IERC20(TSLA).balanceOf(bob), b1);
        assertEq(IERC20(TSLA).balanceOf(writer), 2e18 + 3e18 + 5e18 - (5e18 * (P - strike)) / P);
        assertLe(IERC20(TSLA).balanceOf(address(v)), 1);
        v.withdrawEth(writer);
        v.withdrawEth(feeTo);
        assertEq(writer.balance, 0.01 ether - 0.0001 ether);
        assertEq(feeTo.balance, 0.0001 ether, "1 % fee reached BrimDrip via receive()");
        assertEq(drip.queued(), 0.0001 ether, "no stakers yet: queued");
        console.log("TSLA settle price", P, "alice tokens", a4);
    }

    /// SPY: the close for Fri 30 Oct 21:00 UTC is agg 191 (18:01:49 UTC), proven by the after-hours agg 192; OTM.
    function test_fork_spy_settle_otm() public {
        if (noFork) return;
        uint256 id = _writeReal(SPY, SPY_FEED, 3e18, 10_500);
        vm.prank(alice);
        uint256 p = v.buy{value: 0.006 ether}(id, 3e18, 0.006 ether);
        v.forceExpiry(id, FRI_30_OCT);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, PH | 192);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, PH | 190);
        v.settle(id, PH | 191);
        assertEq(v.offer(id).price, 75459416276);
        v.claimBuyer(p);
        v.claimWriter(id);
        assertEq(IERC20(SPY).balanceOf(alice), 0);
        assertEq(IERC20(SPY).balanceOf(writer), 3e18);
    }

    /// Real feed, no round after expiry for 4 days (stale/paused feed) -> fallback, full refund, all tokens back.
    function test_fork_fallback_stale_feed() public {
        if (noFork) return;
        uint256 id = _writeReal(NVDA, LaunchSetFeed.NVDA, 5e18, 11_000);
        vm.prank(alice);
        uint256 p = v.buy{value: 1 ether}(id, 5e18, 0.01 ether);
        uint64 e = v.offer(id).expiry;
        vm.warp(e + 4 days); // the fork has no prints after the real latest round
        (uint80 latest,,,,) = IFeed(LaunchSetFeed.NVDA).latestRoundData();
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, latest);
        v.settleFallback(id, 0);
        uint256 a0 = alice.balance;
        v.claimBuyer(p);
        assertEq(alice.balance, a0 + 0.01 ether);
        v.claimWriter(id);
        assertEq(IERC20(NVDA).balanceOf(writer), 5e18);
        assertEq(v.ethOwed(feeTo), 0);
        assertEq(address(v).balance, 0);
    }

    /// The real token consults the issuer registry on transfer: a blocked buyer cannot receive, but the writer's
    /// claim and ETH are unaffected; once unblocked the buyer claims.
    function test_fork_blocked_buyer_isolated() public {
        if (noFork) return;
        uint256 id = _writeReal(TSLA, TSLA_FEED, 4e18, 10_100);
        vm.prank(alice);
        uint256 p = v.buy{value: 0.008 ether}(id, 4e18, 0.008 ether);
        v.forceExpiry(id, FRI_06_NOV);
        v.forceStrike(id, 300e8);
        v.settle(id, PH | 2025);
        vm.mockCall(REGISTRY, abi.encodeCall(IRegistry.isBlocked, (alice)), abi.encode(true));
        vm.expectRevert();
        v.claimBuyer(p);
        v.claimWriter(id);
        v.withdrawEth(writer);
        assertGt(IERC20(TSLA).balanceOf(writer), 0);
        vm.clearMockedCalls();
        v.claimBuyer(p);
        assertGt(IERC20(TSLA).balanceOf(alice), 0);
        assertLe(IERC20(TSLA).balanceOf(address(v)), 1);
    }

    /// Holiday-Friday model on real rounds: expiry moved to Sun 08 Nov 21:00 UTC, whose last round (agg 2025, Fri
    /// 20:55) is 48 h old -> not settleable; fallback reason 3 after 4 days.
    function test_fork_stale_close_falls_back() public {
        if (noFork) return;
        uint256 id = _writeReal(TSLA, TSLA_FEED, 2e18, 10_100);
        vm.prank(alice);
        uint256 p = v.buy{value: 0.004 ether}(id, 2e18, 0.004 ether);
        uint64 e = FRI_06_NOV + 2 days;
        v.forceExpiry(id, e);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, PH | 2025);
        vm.warp(e + 4 days);
        vm.expectEmit(address(v));
        emit BrimVault.FellBack(id, 3);
        v.settleFallback(id, PH | 2025);
        v.claimBuyer(p);
        v.claimWriter(id);
        assertEq(alice.balance, 10 ether);
        assertEq(IERC20(TSLA).balanceOf(writer), 2e18);
    }

    /// Real feed: an ATM write (strike == live price) is refused; a 1-unit-OTM write is accepted and buyable; once the
    /// strike is at/below the live price (moved with the harness), buy is refused (anti pick-off).
    function test_fork_strike_rules_and_anti_pickoff() public {
        if (noFork) return;
        uint256 px = _freshen(TSLA_FEED);
        deal(TSLA, writer, 2e18);
        vm.startPrank(writer);
        IERC20(TSLA).approve(address(v), 2e18);
        vm.expectRevert(BrimVault.BadStrike.selector);
        v.write(TSLA, 1e18, px, _nextExpiry(), 0.002 ether);
        uint256 id = v.write(TSLA, 2e18, px + 1, _nextExpiry(), 0.002 ether);
        vm.stopPrank();
        vm.prank(alice);
        v.buy{value: 0.002 ether}(id, 1e18, 0.002 ether);
        v.forceStrike(id, px);
        vm.prank(alice);
        vm.expectRevert(BrimVault.InTheMoney.selector);
        v.buy{value: 0.002 ether}(id, 1e18, 0.002 ether);
    }

    /// Real tokens pass the fee-on-transfer check (exact balance delta) for every listed stock.
    function test_fork_every_token_writes() public {
        if (noFork) return;
        for (uint256 i; i < tok.length; ++i) {
            (, int256 a,, uint256 upd,) = IFeed(fd[i]).latestRoundData();
            if (block.timestamp > upd + 26 hours) {
                console.log("skip (stale on this fork)", sym[i]);
                continue;
            }
            deal(tok[i], writer, 1e18);
            vm.startPrank(writer);
            IERC20(tok[i]).approve(address(v), 1e18);
            uint256 id = v.write(tok[i], 1e18, uint256(a) + 1, _nextExpiry(), 0);
            v.cancel(id, 1e18);
            vm.stopPrank();
            assertEq(IERC20(tok[i]).balanceOf(writer), 1e18, sym[i]);
        }
    }
}

library LaunchSetFeed {
    address internal constant NVDA = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
}
