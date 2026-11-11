// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrimVault} from "../src/BrimVault.sol";
import {MockStock, MockFeed, FeeToken, PlainToken, Rejecter} from "./mocks/Mocks.sol";

contract BrimVaultTest is Test {
    BrimVault v;
    MockStock stk;
    MockFeed feed;
    address writer = makeAddr("writer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address feeTo = makeAddr("feeTo");

    uint64 constant FRI0 = 1_793_998_800; // Fri 06 Nov 2026 21:00 UTC
    uint64 constant EXP = FRI0 + 1 weeks; // Fri 13 Nov 2026 21:00 UTC
    uint256 constant T0 = FRI0 + 2 days + 15 hours; // Mon 09 Nov 12:00 UTC
    uint256 constant PPT = 0.01 ether; // premium per 1e18 tokens
    int256 constant PX = 100e8;

    function setUp() public {
        vm.warp(T0);
        stk = new MockStock("NVDA");
        feed = new MockFeed();
        feed.pushNow(PX);
        v = _deploy(address(stk), address(feed), 50);
        stk.mint(writer, 1_000e18);
        vm.prank(writer);
        stk.approve(address(v), type(uint256).max);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _deploy(address t, address f, uint256 fee) internal returns (BrimVault) {
        address[] memory ts = new address[](1);
        address[] memory fs = new address[](1);
        (ts[0], fs[0]) = (t, f);
        return new BrimVault(ts, fs, fee, feeTo);
    }

    function _write(uint256 amt, uint256 strike) internal returns (uint256) {
        vm.prank(writer);
        return v.write(address(stk), amt, strike, EXP, PPT);
    }

    function _buy(address who, uint256 id, uint256 amt) internal returns (uint256) {
        vm.prank(who);
        return v.buy{value: 10 ether}(id, amt, type(uint256).max);
    }

    /// prints the Friday close round (EXP - 5 min) and the next round at `t` (> EXP); returns the close round
    function _printAround(int256 closePx, uint256 t) internal returns (uint80 id) {
        id = feed.push(closePx, EXP - 5 minutes);
        feed.push(closePx, t);
    }

    // ─────────── constructor ───────────

    function test_constructor_rejects() public {
        address[] memory ts = new address[](2);
        address[] memory fs = new address[](2);
        (ts[0], fs[0], ts[1], fs[1]) = (address(stk), address(feed), address(stk), address(feed));
        vm.expectRevert(BrimVault.BadConfig.selector);
        new BrimVault(ts, fs, 50, feeTo); // duplicate
        address[] memory one = new address[](1);
        one[0] = address(stk);
        vm.expectRevert(BrimVault.BadConfig.selector);
        new BrimVault(one, fs, 50, feeTo); // length
        vm.expectRevert(BrimVault.BadConfig.selector);
        _deploy(address(stk), address(feed), 101); // fee cap
        address[] memory f1 = new address[](1);
        f1[0] = address(feed);
        vm.expectRevert(BrimVault.BadConfig.selector);
        new BrimVault(one, f1, 50, address(0));
        f1[0] = address(0x1234);
        vm.expectRevert(BrimVault.BadConfig.selector);
        new BrimVault(one, f1, 50, feeTo); // feed without code
        BrimVault ok = _deploy(address(stk), address(feed), 100);
        assertEq(ok.feeBps(), 100);
        assertEq(ok.feedOf(address(stk)), address(feed));
        assertEq(ok.tokenCount(), 1);
    }

    // ─────────── write ───────────

    function test_write_pulls_tokens() public {
        uint256 id = _write(10e18, 105e8);
        assertEq(stk.balanceOf(address(v)), 10e18);
        BrimVault.Offer memory o = v.offer(id);
        assertEq(o.writer, writer);
        assertEq(o.available, 10e18);
        assertEq(o.strike, 105e8);
        assertEq(o.expiry, EXP);
    }

    function test_write_expiry_grid() public {
        vm.startPrank(writer);
        vm.expectRevert(BrimVault.BadExpiry.selector);
        v.write(address(stk), 1e18, 101e8, EXP - 1 hours, PPT); // not on grid
        vm.expectRevert(BrimVault.BadExpiry.selector);
        v.write(address(stk), 1e18, 101e8, EXP + 4 weeks, PPT); // > 28 days
        v.write(address(stk), 1e18, 101e8, EXP + 3 weeks, PPT); // 25.4 days ok
        vm.stopPrank();
        vm.warp(EXP - 1 days);
        feed.pushNow(PX);
        vm.prank(writer);
        v.write(address(stk), 1e18, 101e8, EXP, PPT); // exactly 1 day ok
        vm.warp(EXP - 1 days + 1); // less than 1 day ahead
        vm.prank(writer);
        vm.expectRevert(BrimVault.BadExpiry.selector);
        v.write(address(stk), 1e18, 101e8, EXP, PPT);
    }

    function test_write_strike_and_price_rules() public {
        vm.startPrank(writer);
        vm.expectRevert(BrimVault.BadStrike.selector);
        v.write(address(stk), 1e18, 100e8 - 1, EXP, PPT); // ITM refused
        vm.expectRevert(BrimVault.BadStrike.selector);
        v.write(address(stk), 1e18, 100e8, EXP, PPT); // ATM refused (strike must be > price)
        v.write(address(stk), 1e18, 100e8 + 1, EXP, PPT); // 1 unit OTM ok
        vm.expectRevert(BrimVault.UnknownToken.selector);
        v.write(address(0xbeef), 1e18, 101e8, EXP, PPT);
        vm.expectRevert(BrimVault.BadAmount.selector);
        v.write(address(stk), 0, 101e8, EXP, PPT);
        vm.stopPrank();
        vm.warp(T0 + 26 hours + 1); // stale
        vm.prank(writer);
        vm.expectRevert(BrimVault.BadPrice.selector);
        v.write(address(stk), 1e18, 101e8, EXP, PPT);
        feed.pushNow(PX);
        stk.setOraclePaused(true);
        vm.prank(writer);
        vm.expectRevert(BrimVault.BadPrice.selector);
        v.write(address(stk), 1e18, 101e8, EXP, PPT);
    }

    function test_write_rejects_fee_on_transfer() public {
        FeeToken ft = new FeeToken();
        BrimVault v2 = _deploy(address(ft), address(feed), 50);
        ft.mint(writer, 10e18);
        vm.startPrank(writer);
        ft.approve(address(v2), type(uint256).max);
        vm.expectRevert(BrimVault.FeeOnTransfer.selector);
        v2.write(address(ft), 10e18, 101e8, EXP, PPT);
        vm.stopPrank();
    }

    // ─────────── buy ───────────

    function test_buy_partial_and_refund_excess() public {
        uint256 id = _write(10e18, 110e8);
        uint256 a0 = alice.balance;
        uint256 pid = _buy(alice, id, 3e18);
        assertEq(alice.balance, a0 - 0.03 ether, "excess refunded");
        assertEq(address(v).balance, 0.03 ether);
        BrimVault.Position memory p = v.position(pid);
        assertEq(p.amount, 3e18);
        assertEq(p.premium, 0.03 ether);
        assertEq(v.offer(id).available, 7e18);
        assertEq(v.offer(id).sold, 3e18);
        assertEq(v.offer(id).escrow, 0.03 ether);
        _buy(bob, id, 7e18);
        vm.expectRevert(BrimVault.BadAmount.selector);
        _buy(bob, id, 1);
    }

    function test_buy_premium_rounds_up_and_maxPremium() public {
        uint256 id = _write(10e18, 110e8);
        vm.prank(alice);
        uint256 pid = v.buy{value: 1}(id, 1, 1); // 1 wei of token -> ceil = 1 wei of ETH
        assertEq(v.position(pid).premium, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BrimVault.PremiumTooHigh.selector, 0.01 ether));
        v.buy{value: 1 ether}(id, 1e18, 0.01 ether - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BrimVault.PremiumTooHigh.selector, 0.01 ether));
        v.buy{value: 0.01 ether - 1}(id, 1e18, type(uint256).max); // underpaid
    }

    function test_buy_cutoff() public {
        uint256 id = _write(10e18, 110e8);
        vm.warp(EXP - 2 hours - 1);
        feed.pushNow(PX);
        _buy(alice, id, 1e18);
        vm.warp(EXP - 2 hours);
        vm.expectRevert(BrimVault.BuyClosed.selector);
        _buy(alice, id, 1e18);
    }

    function test_buy_refund_failure_reverts() public {
        uint256 id = _write(10e18, 110e8);
        Rejecter r = new Rejecter();
        vm.deal(address(this), 1 ether);
        vm.expectRevert(bytes("call failed"));
        r.call{value: 1 ether}(address(v), abi.encodeCall(BrimVault.buy, (id, 1e18, type(uint256).max)));
    }

    // ─────────── anti pick-off ───────────

    function test_buy_refused_at_or_above_strike() public {
        uint256 id = _write(10e18, 110e8);
        feed.pushNow(110e8); // price reached the strike
        vm.expectRevert(BrimVault.InTheMoney.selector);
        _buy(alice, id, 1e18);
        feed.pushNow(125e8);
        vm.expectRevert(BrimVault.InTheMoney.selector);
        _buy(alice, id, 1e18);
        feed.pushNow(110e8 - 1);
        _buy(alice, id, 1e18);
    }

    function test_every_written_offer_is_buyable() public {
        uint256 id = _write(10e18, 100e8 + 1); // the tightest strike write allows
        _buy(alice, id, 1e18); // buyable right away at the same price
        assertEq(v.offer(id).sold, 1e18);
    }

    function testFuzz_write_strike_strictly_above_price(uint256 strike) public {
        strike = bound(strike, 1, 1_000e8);
        vm.prank(writer);
        if (strike <= 100e8) {
            vm.expectRevert(BrimVault.BadStrike.selector);
            v.write(address(stk), 1e18, strike, EXP, PPT);
        } else {
            uint256 id = v.write(address(stk), 1e18, strike, EXP, PPT);
            _buy(alice, id, 1e18); // and it can be bought at the write-time price
        }
    }

    function test_buy_price_age_weekend_ok() public {
        uint64 exp2 = EXP + 1 weeks;
        vm.prank(writer);
        uint256 id = v.write(address(stk), 10e18, 110e8, exp2, PPT);
        feed.push(PX, EXP - 5 minutes); // Friday close
        vm.warp(EXP + 2 days); // Sunday 21:00 UTC, feed silent since Friday
        _buy(alice, id, 1e18);
        vm.warp(EXP - 5 minutes + 4 days + 1); // > 4 days old
        vm.expectRevert(BrimVault.BadPrice.selector);
        _buy(alice, id, 1e18);
        vm.warp(EXP + 2 days);
        stk.setOraclePaused(true);
        vm.expectRevert(BrimVault.BadPrice.selector);
        _buy(alice, id, 1e18);
    }

    // ─────────── cancel ───────────

    function test_cancel_after_partial_buys() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 4e18);
        vm.prank(alice);
        vm.expectRevert(BrimVault.NotWriter.selector);
        v.cancel(id, 1e18);
        vm.startPrank(writer);
        vm.expectRevert(BrimVault.BadAmount.selector);
        v.cancel(id, 6e18 + 1); // cannot touch sold collateral
        v.cancel(id, 2e18);
        v.cancel(id, 4e18);
        vm.stopPrank();
        assertEq(stk.balanceOf(writer), 1_000e18 - 4e18);
        assertEq(stk.balanceOf(address(v)), 4e18, "sold collateral stays");
        vm.expectRevert(BrimVault.BadAmount.selector);
        _buy(bob, id, 1);
        // settle still works for the sold part
        vm.warp(EXP + 52 hours);
        uint80 r = _printAround(125e8, EXP + 52 hours);
        v.settle(id, r);
        v.claimBuyer(0);
        v.claimWriter(id);
        assertEq(stk.balanceOf(alice), 4e18 * 15 / 125); // 0.48e18
        assertEq(stk.balanceOf(address(v)), 0);
    }

    // ─────────── settle ───────────

    function test_settle_itm() public {
        uint256 id = _write(10e18, 110e8);
        uint256 p1 = _buy(alice, id, 6e18);
        uint256 p2 = _buy(bob, id, 1e18);
        vm.warp(EXP + 52 hours);
        uint80 r = _printAround(132e8, EXP + 52 hours);
        vm.expectEmit(address(v));
        emit BrimVault.Settled(id, r, 132e8, 0.07 ether - 0.00035 ether, 0.00035 ether);
        v.settle(id, r);
        v.claimBuyer(p1);
        v.claimBuyer(p2);
        v.claimWriter(id);
        assertEq(stk.balanceOf(alice), uint256(6e18) * 22e8 / 132e8);
        assertEq(stk.balanceOf(bob), uint256(1e18) * 22e8 / 132e8);
        assertEq(stk.balanceOf(writer) + stk.balanceOf(alice) + stk.balanceOf(bob) + stk.balanceOf(address(v)), 1_000e18);
        assertLe(stk.balanceOf(address(v)), 2, "dust only");
        assertEq(v.ethOwed(writer), 0.06965 ether);
        assertEq(v.ethOwed(feeTo), 0.00035 ether);
        v.withdrawEth(writer);
        v.withdrawEth(feeTo);
        assertEq(writer.balance, 0.06965 ether);
        assertEq(feeTo.balance, 0.00035 ether);
        assertEq(address(v).balance, 0);
        vm.expectRevert(BrimVault.AlreadyClaimed.selector);
        v.claimBuyer(p1);
        vm.expectRevert(BrimVault.AlreadyClaimed.selector);
        v.claimWriter(id);
        vm.expectRevert(BrimVault.BadAmount.selector);
        v.withdrawEth(writer);
    }

    function test_settle_otm_and_at_strike() public {
        uint256 id = _write(10e18, 110e8);
        uint256 p1 = _buy(alice, id, 5e18);
        vm.warp(EXP + 1 hours);
        uint80 r = _printAround(110e8, EXP + 1 hours); // P == K -> nothing to buyers
        v.settle(id, r);
        v.claimBuyer(p1);
        v.claimWriter(id);
        assertEq(stk.balanceOf(alice), 0);
        assertEq(stk.balanceOf(writer), 1_000e18);
        assertEq(v.ethOwed(writer), 0.05 ether - 0.05 ether * 50 / 10_000);
    }

    function test_settle_round_selection() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 early = feed.push(PX, EXP - 2 hours);
        uint80 close = feed.push(120e8, EXP); // updatedAt == expiry counts as "at or before"
        uint80 after1 = feed.push(130e8, EXP + 1);
        vm.warp(EXP - 1);
        vm.expectRevert(BrimVault.TooEarly.selector);
        v.settle(id, close);
        vm.warp(EXP + 1 hours);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, early); // not the last before expiry
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, after1); // after expiry
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, after1 + 1); // missing
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, close + (uint80(1) << 64)); // phase that does not exist
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, uint80(1) << 64); // agg 0
        v.settle(id, close);
        assertEq(v.offer(id).price, 120e8);
        vm.expectRevert(BrimVault.NotOpen.selector);
        v.settle(id, close);
    }

    function test_settle_needs_next_round_then_minutes_after_expiry() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 close = feed.push(115e8, EXP - 3 minutes);
        vm.warp(EXP + 1 minutes);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, close); // round + 1 not printed yet: "last" unproven
        feed.push(116e8, EXP + 2 minutes); // after-hours print
        vm.warp(EXP + 3 minutes);
        v.settle(id, close);
        assertEq(v.offer(id).price, 115e8);
    }

    function test_settle_close_age_limit() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 close = feed.push(120e8, EXP - 26 hours); // exactly 26 h old: ok
        feed.push(121e8, EXP + 52 hours);
        vm.warp(EXP + 53 hours);
        v.settle(id, close);
        assertEq(v.offer(id).price, 120e8); // (a close older than 26 h: test_settle_stale_close_falls_back)
    }

    function test_settle_stale_close_falls_back() public {
        uint256 id = _write(10e18, 110e8);
        uint256 p = _buy(alice, id, 2e18);
        uint80 close = feed.push(120e8, EXP - 26 hours - 1); // holiday Friday: Thursday's print
        feed.push(150e8, EXP + 52 hours);
        vm.warp(EXP + 53 hours);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, close);
        vm.expectRevert(BrimVault.TooEarly.selector);
        v.settleFallback(id, close);
        vm.warp(EXP + 4 days);
        vm.expectEmit(address(v));
        emit BrimVault.FellBack(id, 3);
        v.settleFallback(id, close);
        uint256 a0 = alice.balance;
        v.claimBuyer(p);
        assertEq(alice.balance, a0 + 0.02 ether, "full refund, no fee");
        v.claimWriter(id);
        assertEq(stk.balanceOf(writer), 1_000e18);
        assertEq(v.ethOwed(feeTo), 0);
        assertEq(address(v).balance, 0);
    }

    function test_settle_requires_current_phase() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 close = feed.push(120e8, EXP - 5 minutes);
        feed.newPhase();
        uint80 p2a = feed.push(121e8, EXP + 2 hours); // phase 2 starts after expiry
        feed.push(122e8, EXP + 3 hours);
        vm.warp(EXP + 3 hours);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, close); // old phase (and its round + 1 does not exist)
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, p2a);
        vm.warp(EXP + 4 days);
        vm.expectRevert(BrimVault.NotEligible.selector);
        v.settleFallback(id, p2a + 1); // not round 1 of the phase: no proof
        vm.expectEmit(address(v));
        emit BrimVault.FellBack(id, 3);
        v.settleFallback(id, p2a);
    }

    function test_settle_gap_after_close() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 close = feed.push(PX, EXP - 1 hours);
        feed.skipRound(); // round + 1 reads as zeros
        feed.push(120e8, EXP + 1 hours);
        vm.warp(EXP + 2 hours);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, close);
        vm.warp(EXP + 4 days);
        vm.expectRevert(BrimVault.NotEligible.selector);
        v.settleFallback(id, close); // unprovable either way -> only the long stop
        vm.warp(EXP + 30 days);
        v.settleFallback(id, 0);
        assertEq(uint8(v.offer(id).status), 2);
    }

    function test_settle_late_next_round_still_settles() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 r = _printAround(120e8, EXP + 5 days); // next print only after the window
        vm.warp(EXP + 5 days + 1);
        v.settle(id, r); // nobody fell back in between: settlement is still valid
        assertEq(v.offer(id).price, 120e8);
    }

    function test_fallback_before_next_round_prints() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        feed.push(120e8, EXP - 5 minutes);
        vm.warp(EXP + 4 days); // Monday holiday + more: nothing printed after expiry
        vm.expectEmit(address(v));
        emit BrimVault.FellBack(id, 2);
        v.settleFallback(id, 0);
    }

    function test_settle_issuer_hold() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 r = _printAround(120e8, EXP + 52 hours);
        vm.warp(EXP + 53 hours);
        stk.setOraclePaused(true);
        vm.expectRevert(BrimVault.IssuerHold.selector);
        v.settle(id, r);
        stk.setOraclePaused(false);
        stk.setEffectiveAt(EXP + 12 hours); // split / dividend right after the close
        vm.expectRevert(BrimVault.IssuerHold.selector);
        v.settle(id, r);
        stk.setEffectiveAt(EXP - 20 hours); // just before the close
        vm.expectRevert(BrimVault.IssuerHold.selector);
        v.settle(id, r);
        vm.warp(EXP + 4 days);
        vm.expectEmit(address(v));
        emit BrimVault.FellBack(id, 1);
        v.settleFallback(id, r);
    }

    function test_corporate_action_outside_margin_ok() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 r = _printAround(120e8, EXP + 52 hours);
        vm.warp(EXP + 53 hours);
        stk.setEffectiveAt(EXP + 1 days); // exactly at the margin -> not a hold
        v.settle(id, r);
    }

    function test_corporate_action_before_margin_ok() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 r = _printAround(120e8, EXP + 52 hours);
        vm.warp(EXP + 53 hours);
        stk.setEffectiveAt(EXP - 5 minutes - 1 days); // close - 1 day -> not a hold
        v.settle(id, r);
    }

    function test_plain_token_without_issuer_views() public {
        PlainToken pt = new PlainToken();
        BrimVault v2 = _deploy(address(pt), address(feed), 0);
        pt.mint(writer, 1e18);
        vm.startPrank(writer);
        pt.approve(address(v2), 1e18);
        uint256 id = v2.write(address(pt), 1e18, 101e8, EXP, PPT);
        vm.stopPrank();
        vm.prank(alice);
        v2.buy{value: 0.01 ether}(id, 1e18, 0.01 ether);
        uint80 r = _printAround(200e8, EXP + 1 hours);
        vm.warp(EXP + 2 hours);
        v2.settle(id, r);
        v2.claimBuyer(0);
        assertEq(pt.balanceOf(alice), uint256(1e18) * 99e8 / 200e8);
        assertEq(v2.ethOwed(writer), 0.01 ether);
        assertEq(v2.ethOwed(feeTo), 0);
    }

    // ─────────── fallback ───────────

    function test_fallback_no_round_after_expiry() public {
        uint256 id = _write(10e18, 110e8);
        uint256 p = _buy(alice, id, 10e18);
        feed.push(PX, EXP - 1 hours);
        vm.warp(EXP + 4 days - 1);
        vm.expectRevert(BrimVault.TooEarly.selector);
        v.settleFallback(id, 0);
        vm.warp(EXP + 4 days);
        vm.expectEmit(address(v));
        emit BrimVault.FellBack(id, 2);
        v.settleFallback(id, 0);
        vm.expectRevert(BrimVault.NotOpen.selector);
        v.settle(id, 0);
        v.claimBuyer(p);
        v.claimWriter(id);
        assertEq(alice.balance, 100 ether);
        assertEq(stk.balanceOf(writer), 1_000e18);
    }

    function test_fallback_refused_when_settlement_possible() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        uint80 r = _printAround(150e8, EXP + 52 hours);
        vm.warp(EXP + 10 days);
        vm.expectRevert(BrimVault.NotEligible.selector);
        v.settleFallback(id, r);
        vm.expectRevert(BrimVault.NotEligible.selector);
        v.settleFallback(id, r + 1); // a later round is no proof of absence
        vm.expectRevert(BrimVault.NotEligible.selector);
        v.settleFallback(id, 0);
        vm.warp(EXP + 30 days); // long stop
        v.settleFallback(id, 0);
    }

    function test_fallback_oracle_paused() public {
        uint256 id = _write(10e18, 110e8);
        _buy(alice, id, 1e18);
        _printAround(150e8, EXP + 52 hours);
        vm.warp(EXP + 4 days);
        stk.setOraclePaused(true);
        v.settleFallback(id, 0);
        assertEq(uint8(v.offer(id).status), 2);
    }

    function test_fallback_refund_to_rejecting_buyer_is_credited() public {
        uint256 id = _write(10e18, 110e8);
        Rejecter r = new Rejecter();
        vm.deal(address(r), 1 ether);
        vm.prank(address(r));
        v.buy{value: 0.01 ether}(id, 1e18, 0.01 ether);
        vm.warp(EXP + 4 days);
        v.settleFallback(id, 0);
        v.claimBuyer(0);
        assertEq(v.ethOwed(address(r)), 0.01 ether);
        vm.expectRevert(BrimVault.RefundFailed.selector);
        v.withdrawEth(address(r));
    }

    // ─────────── one side blocked / paused ───────────

    function test_blocked_buyer_does_not_lock_writer() public {
        uint256 id = _write(10e18, 110e8);
        uint256 p = _buy(alice, id, 5e18);
        uint80 r = _printAround(220e8, EXP + 1 hours);
        vm.warp(EXP + 2 hours);
        v.settle(id, r);
        stk.setBlocked(alice, true);
        vm.expectRevert(bytes("blocked"));
        v.claimBuyer(p);
        v.claimWriter(id);
        assertEq(stk.balanceOf(writer), 1_000e18 - 2.5e18);
        v.withdrawEth(writer);
        stk.setBlocked(alice, false);
        v.claimBuyer(p); // later, once unblocked
        assertEq(stk.balanceOf(alice), 2.5e18);
    }

    function test_blocked_writer_does_not_lock_buyer() public {
        uint256 id = _write(10e18, 110e8);
        uint256 p = _buy(alice, id, 5e18);
        uint80 r = _printAround(220e8, EXP + 1 hours);
        vm.warp(EXP + 2 hours);
        v.settle(id, r);
        stk.setBlocked(writer, true);
        vm.expectRevert(bytes("blocked"));
        v.claimWriter(id);
        v.claimBuyer(p);
        assertEq(stk.balanceOf(alice), 2.5e18);
        v.withdrawEth(writer); // ETH premium is not stuck behind the token
        assertGt(writer.balance, 0);
    }

    function test_paused_token_eth_still_flows() public {
        uint256 id = _write(10e18, 110e8);
        uint256 p = _buy(alice, id, 5e18);
        vm.warp(EXP + 4 days);
        stk.setPaused(true);
        v.settleFallback(id, 0); // reason 2: no round after expiry
        v.claimBuyer(p); // ETH refund needs no token transfer
        assertEq(alice.balance, 100 ether);
        vm.expectRevert(bytes("paused"));
        v.claimWriter(id);
        stk.setPaused(false);
        v.claimWriter(id);
        assertEq(stk.balanceOf(writer), 1_000e18);
    }

    function test_claims_before_resolution_revert() public {
        uint256 id = _write(10e18, 110e8);
        uint256 p = _buy(alice, id, 1e18);
        vm.expectRevert(BrimVault.NotOpen.selector);
        v.claimBuyer(p);
        vm.expectRevert(BrimVault.NotOpen.selector);
        v.claimWriter(id);
    }

    function test_two_offers_same_token_isolated() public {
        address w2 = makeAddr("w2");
        stk.mint(w2, 50e18);
        vm.prank(w2);
        stk.approve(address(v), type(uint256).max);
        uint256 a = _write(10e18, 110e8);
        vm.prank(w2);
        uint256 b = v.write(address(stk), 50e18, 150e8, EXP, PPT);
        uint256 pa = _buy(alice, a, 10e18);
        uint256 pb = _buy(bob, b, 50e18);
        uint80 r = _printAround(200e8, EXP + 52 hours);
        vm.warp(EXP + 53 hours);
        v.settle(a, r);
        v.claimBuyer(pa);
        v.claimWriter(a);
        assertEq(stk.balanceOf(address(v)), 50e18, "offer b collateral untouched");
        v.settle(b, r);
        v.claimBuyer(pb);
        v.claimWriter(b);
        assertEq(stk.balanceOf(alice), 4.5e18);
        assertEq(stk.balanceOf(bob), 12.5e18);
        assertEq(stk.balanceOf(w2), 37.5e18);
        assertEq(stk.balanceOf(address(v)), 0);
    }

    function test_reentry_on_refund_blocked() public {
        uint256 id = _write(10e18, 110e8);
        ReBuyer rb = new ReBuyer(v, id);
        vm.deal(address(rb), 1 ether);
        vm.expectRevert(BrimVault.RefundFailed.selector); // the nested buy hits nonReentrant -> refund fails
        rb.go();
        assertEq(v.positionCount(), 0);
    }

    function test_claims_callable_by_anyone_pay_owner() public {
        uint256 id = _write(10e18, 110e8);
        uint256 p = _buy(alice, id, 2e18);
        uint80 r = _printAround(220e8, EXP + 1 hours);
        vm.warp(EXP + 2 hours);
        vm.startPrank(makeAddr("keeper"));
        v.settle(id, r);
        v.claimBuyer(p);
        v.claimWriter(id);
        v.withdrawEth(writer);
        vm.stopPrank();
        assertEq(stk.balanceOf(alice), 1e18);
        assertEq(stk.balanceOf(writer), 999e18);
        assertEq(writer.balance, 0.02 ether - 0.0001 ether);
    }

    // ─────────── fuzz ───────────

    function testFuzz_payout_math(uint256 amount, uint256 price, uint256 strike) public view {
        amount = bound(amount, 0, 1e30);
        strike = bound(strike, 1, 1e15);
        price = bound(price, 1, 1e15);
        uint256 out = v.payoutOf(amount, price, strike);
        assertLe(out, amount);
        if (price <= strike) assertEq(out, 0);
        else assertEq(out, amount * (price - strike) / price);
    }

    /// N buyers with random sizes, a random settlement price; after every claim the vault holds exactly the dust
    /// (never less than zero = every claim succeeded) and no ETH; totals are conserved.
    function testFuzz_rounding_never_overpays(uint256 seed, uint8 nBuys, uint256 price, uint256 ppt) public {
        uint256 n = bound(nBuys, 1, 12);
        price = bound(price, 1e8, 1e13);
        ppt = bound(ppt, 0, 10 ether);
        uint256 total = 1_000e18;
        vm.prank(writer);
        uint256 id = v.write(address(stk), total, 101e8, EXP, ppt);
        uint256 left = total;
        uint256 ethIn;
        for (uint256 i; i < n && left > 0; ++i) {
            uint256 amt = bound(uint256(keccak256(abi.encode(seed, i))), 1, left);
            if (i == n - 1 && seed % 2 == 0) amt = left;
            left -= amt;
            address b = address(uint160(0x1000 + i));
            vm.deal(b, 1e30);
            vm.prank(b);
            v.buy{value: 1e30}(id, amt, type(uint256).max);
            ethIn += v.position(i).premium;
        }
        assertEq(address(v).balance, ethIn);
        uint80 r = _printAround(int256(price), EXP + 52 hours);
        vm.warp(EXP + 52 hours);
        v.settle(id, r);
        uint256 paid;
        for (uint256 i; i < v.positionCount(); ++i) {
            v.claimBuyer(i);
            paid += stk.balanceOf(address(uint160(0x1000 + i)));
        }
        v.claimWriter(id);
        uint256 dust = stk.balanceOf(address(v));
        assertEq(paid + stk.balanceOf(writer) + dust, 1_000e18);
        assertLt(dust, v.positionCount() + 1, "dust <= 1 wei per position");
        if (v.ethOwed(writer) > 0) v.withdrawEth(writer);
        if (v.ethOwed(feeTo) > 0) v.withdrawEth(feeTo);
        assertEq(address(v).balance, 0, "ETH fully distributed");
        assertEq(writer.balance + feeTo.balance, ethIn);
        assertLe(feeTo.balance, ethIn * 50 / 10_000);
    }

    function testFuzz_fallback_refunds_exactly(uint256 seed, uint8 nBuys, uint256 ppt) public {
        uint256 n = bound(nBuys, 1, 10);
        ppt = bound(ppt, 1, 10 ether);
        vm.prank(writer);
        uint256 id = v.write(address(stk), 1_000e18, 101e8, EXP, ppt);
        for (uint256 i; i < n; ++i) {
            address b = address(uint160(0x2000 + i));
            vm.deal(b, 1e30);
            vm.prank(b);
            v.buy{value: 1e30}(id, bound(uint256(keccak256(abi.encode(seed, i))), 1, 100e18), type(uint256).max);
        }
        vm.warp(EXP + 4 days);
        v.settleFallback(id, 0);
        for (uint256 i; i < n; ++i) {
            v.claimBuyer(i);
            assertEq(address(uint160(0x2000 + i)).balance, 1e30);
        }
        v.claimWriter(id);
        assertEq(address(v).balance, 0);
        assertEq(stk.balanceOf(address(v)), 0);
        assertEq(stk.balanceOf(writer), 1_000e18);
    }
}

contract ReBuyer {
    BrimVault v;
    uint256 id;

    constructor(BrimVault v_, uint256 id_) {
        (v, id) = (v_, id_);
    }

    function go() external {
        v.buy{value: 0.5 ether}(id, 1e18, type(uint256).max);
    }

    receive() external payable {
        v.buy{value: 0.01 ether}(id, 1e18, type(uint256).max);
    }
}
