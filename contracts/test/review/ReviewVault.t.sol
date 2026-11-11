// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrimVault} from "../../src/BrimVault.sol";
import {MockStock, MockFeed} from "../mocks/Mocks.sol";

/// A writer that is a contract without receive()/fallback (e.g. a minimal vault/escrow contract).
contract NoReceiveWriter {
    function approve(MockStock t, address s) external { t.approve(s, type(uint256).max); }
    function write(BrimVault v, address t, uint256 a, uint256 k, uint64 e, uint256 p) external returns (uint256) {
        return v.write(t, a, k, e, p);
    }
    function pullTo(BrimVault v, address to) external { v.withdrawEthTo(to); }
}

/// Independent review: proofs for REVIEW.md findings (vault).
contract ReviewVaultTest is Test {
    BrimVault v;
    MockStock stk;
    MockFeed feed;
    address writer = makeAddr("writer");
    address alice = makeAddr("alice");
    address feeTo = makeAddr("feeTo");

    uint64 constant FRI0 = 1_793_998_800; // Fri 06 Nov 2026 21:00 UTC
    uint64 constant EXP = FRI0 + 1 weeks;
    uint256 constant T0 = FRI0 + 2 days + 15 hours; // Mon 09 Nov 12:00 UTC
    uint256 constant PPT = 0.01 ether;

    function setUp() public {
        vm.warp(T0);
        stk = new MockStock("NVDA");
        feed = new MockFeed();
        feed.pushNow(100e8);
        address[] memory ts = new address[](1);
        address[] memory fs = new address[](1);
        (ts[0], fs[0]) = (address(stk), address(feed));
        v = new BrimVault(ts, fs, 100, feeTo);
        stk.mint(writer, 1_000e18);
        vm.prank(writer);
        stk.approve(address(v), type(uint256).max);
        vm.deal(alice, 100 ether);
    }

    function _offer(uint256 strike) internal returns (uint256 id) {
        vm.prank(writer);
        id = v.write(address(stk), 10e18, strike, EXP, PPT);
        vm.prank(alice);
        v.buy{value: 1 ether}(id, 10e18, type(uint256).max);
    }

    /// INFO: a round with updatedAt == expiry is the close (<= expiry); the round printed at expiry + 1 proves it.
    function test_review_updatedAt_equal_expiry_is_close() public {
        uint256 id = _offer(110e8);
        uint80 before = feed.push(115e8, EXP - 1 hours);
        uint80 atExp = feed.push(120e8, EXP);
        feed.push(130e8, EXP + 1);
        vm.warp(EXP + 1);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, before);
        v.settle(id, atExp);
        assertEq(v.offer(id).price, 120e8);
    }

    /// LOW (L-2): effectiveAt is a single "latest action" slot. An action inside the close window blocks settle,
    /// but once the issuer schedules the NEXT action (overwriting effectiveAt) the guard disappears and settle goes
    /// through on the close that the first action affected.
    function test_review_effectiveAt_overwrite_unblocks_settle() public {
        uint256 id = _offer(110e8);
        uint80 r = feed.push(120e8, EXP - 5 minutes);
        feed.push(120e8, EXP + 52 hours);
        stk.setEffectiveAt(EXP - 6 hours); // dividend / split multiplier change right before the close
        vm.warp(EXP + 53 hours);
        vm.expectRevert(BrimVault.IssuerHold.selector);
        v.settle(id, r);
        // nobody falls back before the issuer schedules the next corporate action
        vm.warp(EXP + 3 days);
        stk.setEffectiveAt(EXP + 40 days);
        v.settle(id, r); // the guard is gone: settles on the close that the earlier action straddled
        assertEq(uint8(v.offer(id).status), uint8(BrimVault.Status.Settled));
    }

    /// LOW (L-1): reason 1 reads oraclePaused NOW, not at the close. An OTM offer whose writer has not settled
    /// by expiry + 4 days can be refunded to the buyer by any unrelated, later issuer oracle pause; the writer
    /// loses the premium although the settlement was valid all along.
    function test_review_late_oracle_pause_flips_otm_outcome() public {
        uint256 id = _offer(110e8);
        uint80 r = feed.push(100e8, EXP - 5 minutes); // OTM close
        feed.push(100e8, EXP + 52 hours);
        vm.warp(EXP + 4 days); // settle was possible for ~44 h, writer did not call it
        stk.setOraclePaused(true); // unrelated issuer pause, e.g. for next week's corporate action
        uint256 b0 = alice.balance;
        v.settleFallback(id, r);
        stk.setOraclePaused(false);
        v.claimBuyer(0);
        assertEq(alice.balance - b0, 0.1 ether, "buyer refunded the full premium of an OTM call");
        assertEq(v.ethOwed(writer), 0, "writer gets nothing");
    }

    /// LOW (L-3): a writer (or a buyer refund credited by _pay) whose address cannot receive ETH has no way to
    /// redirect it: withdrawEth always pays `account`, so the ETH is locked forever.
    function test_review_contract_without_receive_eth_locked() public {
        NoReceiveWriter w = new NoReceiveWriter();
        stk.mint(address(w), 10e18);
        w.approve(stk, address(v));
        uint256 id = w.write(v, address(stk), 10e18, 110e8, EXP, PPT);
        vm.prank(alice);
        v.buy{value: 1 ether}(id, 10e18, type(uint256).max);
        uint80 r = feed.push(100e8, EXP - 5 minutes);
        feed.push(100e8, EXP + 1 hours);
        vm.warp(EXP + 2 hours);
        v.settle(id, r);
        assertEq(v.ethOwed(address(w)), 0.099 ether);
        vm.expectRevert(BrimVault.RefundFailed.selector);
        v.withdrawEth(address(w));
        // L-3 fix: the account itself can route its credit to a receiving address
        address sink = makeAddr("sink");
        w.pullTo(v, sink);
        assertEq(sink.balance, 0.099 ether);
        assertEq(v.ethOwed(address(w)), 0);
        vm.expectRevert(BrimVault.BadAmount.selector);
        w.pullTo(v, sink);
    }

    /// LOW (L-4): over the weekend buys are priced against Friday's print (BUY_PRICE_AGE = 4 days). A buyer who
    /// knows Monday will open above the strike buys the "OTM" call on Sunday at the standing premium.
    function test_review_weekend_stale_buy() public {
        // offer for the NEXT Friday, written Friday afternoon with strike 2 % above the price
        vm.warp(FRI0 + 1 weeks - 3 hours);
        feed.pushNow(100e8);
        vm.prank(writer);
        uint256 id = v.write(address(stk), 10e18, 102e8, EXP + 1 weeks, PPT);
        vm.warp(FRI0 + 1 weeks + 1 days + 20 hours); // Sunday 17:00 UTC, no print since Friday
        vm.prank(alice);
        v.buy{value: 1 ether}(id, 10e18, type(uint256).max); // accepted: Friday print 100 < 102
        assertEq(v.offer(id).sold, 10e18);
    }
}
