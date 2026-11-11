// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrimDrip} from "../src/BrimDrip.sol";
import {BrimVault} from "../src/BrimVault.sol";
import {PlainToken, FeeToken, MockStock, MockFeed} from "./mocks/Mocks.sol";

contract BrimDripTest is Test {
    BrimDrip d;
    PlainToken brim;
    address deployer = makeAddr("deployer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address payer = makeAddr("payer");

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.prank(deployer);
        d = new BrimDrip();
        brim = new PlainToken();
        address[3] memory us = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            brim.mint(us[i], 1_000e18);
            vm.prank(us[i]);
            brim.approve(address(d), type(uint256).max);
        }
        vm.deal(payer, 1_000 ether);
    }

    function _setToken() internal {
        vm.prank(deployer);
        d.setToken(address(brim));
    }

    function _send(uint256 amt) internal {
        vm.prank(payer);
        (bool ok,) = address(d).call{value: amt}(""); // plain ETH transfer (wallet send of Pons creator fees)
        assertTrue(ok);
    }

    function _stake(address u, uint256 a) internal {
        vm.prank(u);
        d.stake(a);
    }

    // ─────────── setToken ───────────

    function test_setToken_single_shot() public {
        vm.prank(alice);
        vm.expectRevert(BrimDrip.NotDeployer.selector);
        d.setToken(address(brim));
        vm.prank(deployer);
        vm.expectRevert(BrimDrip.BadToken.selector);
        d.setToken(address(0x1234)); // no code
        vm.prank(alice);
        vm.expectRevert(BrimDrip.TokenNotSet.selector);
        d.stake(1e18);
        _setToken();
        assertEq(address(d.token()), address(brim));
        address other = address(new PlainToken());
        vm.prank(deployer);
        vm.expectRevert(BrimDrip.TokenAlreadySet.selector);
        d.setToken(other);
    }

    function test_fee_on_transfer_rejected() public {
        FeeToken ft = new FeeToken();
        vm.prank(deployer);
        d.setToken(address(ft));
        ft.mint(alice, 10e18);
        vm.startPrank(alice);
        ft.approve(address(d), type(uint256).max);
        vm.expectRevert(BrimDrip.FeeOnTransfer.selector);
        d.stake(10e18);
        vm.stopPrank();
    }

    // ─────────── stream math ───────────

    function test_stream_linear_over_7_days() public {
        _setToken();
        _stake(alice, 100e18);
        _send(7 ether);
        assertEq(d.rewardRate(), uint256(7 ether) / 7 days);
        assertEq(d.periodFinish(), block.timestamp + 7 days);
        skip(1 days);
        assertApproxEqAbs(d.earned(alice), 1 ether, 1e6);
        skip(2.5 days);
        assertApproxEqAbs(d.earned(alice), 3.5 ether, 1e6);
        skip(10 days); // past the end: capped
        assertApproxEqAbs(d.earned(alice), 7 ether, 1e6);
        uint256 b0 = alice.balance;
        vm.prank(alice);
        uint256 got = d.claim();
        assertEq(alice.balance - b0, got);
        assertLe(got, 7 ether);
        assertEq(address(d).balance, 7 ether - got);
        assertEq(d.pending(), d.queued()); // nothing left in the stream except the division remainder
        assertLt(address(d).balance, 1e6, "only dust");
    }

    function test_notify_while_streaming_restarts_with_leftover() public {
        _setToken();
        _stake(alice, 1e18);
        vm.prank(payer);
        d.notify{value: 7 ether}();
        skip(2 days);
        vm.prank(payer);
        d.notify{value: 7 ether}();
        // leftover = 5 ETH (+ remainder) + 7 ETH new, over a fresh 7 days
        assertApproxEqAbs(d.rewardRate(), uint256(12 ether) / 7 days, 2);
        assertEq(d.periodFinish(), block.timestamp + 7 days);
        assertApproxEqAbs(d.earned(alice), 2 ether, 1e6);
        skip(7 days);
        assertApproxEqAbs(d.earned(alice), 14 ether, 1e6);
    }

    function test_multiple_stakers_proportional() public {
        _setToken();
        _stake(alice, 100e18);
        _stake(bob, 300e18);
        _send(7 ether);
        skip(3.5 days);
        _stake(carol, 400e18); // joins halfway: half the total stake from here on
        skip(3.5 days);
        // first half 3.5 ETH split 1:3; second half 3.5 ETH split 1:3:4
        assertApproxEqAbs(d.earned(alice), 0.875 ether + 0.4375 ether, 1e6);
        assertApproxEqAbs(d.earned(bob), 2.625 ether + 1.3125 ether, 1e6);
        assertApproxEqAbs(d.earned(carol), 1.75 ether, 1e6);
        vm.prank(bob);
        d.unstake(300e18); // unstake any time; rewards stay claimable
        vm.prank(bob);
        d.claim();
        assertApproxEqAbs(bob.balance, 3.9375 ether, 1e6);
        assertEq(brim.balanceOf(bob), 1_000e18);
    }

    // ─────────── MIN_RESTART / kick ───────────

    function test_dust_spam_cannot_delay_stream() public {
        _setToken();
        _stake(alice, 1e18);
        _send(7 ether);
        uint256 finish = d.periodFinish();
        uint256 rate = d.rewardRate();
        for (uint256 i; i < 200; ++i) {
            skip(1 hours);
            _send(1); // 1-wei notifies: queued, never restart
        }
        assertEq(d.periodFinish(), finish, "end date unchanged");
        assertEq(d.rewardRate(), rate);
        vm.expectRevert(BrimDrip.NotReady.selector);
        d.kick();
        vm.warp(finish);
        assertApproxEqAbs(d.earned(alice), 7 ether, 1e6, "paid out on the original schedule");
        assertGe(d.queued(), 200);
    }

    function test_threshold_crossing_by_small_payments() public {
        _setToken();
        _stake(alice, 1e18);
        _send(0.002 ether);
        _send(0.002 ether);
        assertEq(d.rewardRate(), 0, "below MIN_RESTART: waiting");
        assertEq(d.queued(), 0.004 ether);
        assertFalse(d.canKick());
        skip(1 days);
        _send(0.001 ether); // crosses 0.005 ETH -> starts
        assertEq(d.periodFinish(), block.timestamp + 7 days);
        assertEq(d.rewardRate(), uint256(0.005 ether) / 7 days);
        assertLt(d.queued(), 7 days, "only the division remainder stays queued");
        skip(7 days);
        assertApproxEqAbs(d.earned(alice), 0.005 ether, 1e6);
    }

    function test_kick_conditions() public {
        _send(1 ether); // token not set
        vm.expectRevert(BrimDrip.NotReady.selector);
        d.kick();
        _setToken();
        vm.expectRevert(BrimDrip.NotReady.selector);
        d.kick(); // no stakers
        _stake(alice, 1e18);
        vm.prank(carol); // anyone can kick
        d.kick();
        assertEq(d.periodFinish(), block.timestamp + 7 days);
        vm.expectRevert(BrimDrip.NotReady.selector);
        d.kick(); // queued is only the division remainder now
        skip(7 days);
        assertApproxEqAbs(d.earned(alice), 1 ether, 1e6);
    }

    function test_restart_at_threshold_with_leftover() public {
        _setToken();
        _stake(alice, 1e18);
        _send(7 ether);
        skip(3 days);
        _send(0.005 ether); // exactly MIN_RESTART: leftover 4 ETH + 0.005 over a fresh 7 days
        assertEq(d.periodFinish(), block.timestamp + 7 days);
        assertApproxEqAbs(d.rewardRate(), uint256(4.005 ether) / 7 days, 2);
        skip(7 days);
        assertApproxEqAbs(d.earned(alice), 7.005 ether, 1e6);
    }

    // ─────────── zero stakers ───────────

    function test_eth_before_token_and_before_first_stake_is_kept() public {
        _send(3 ether); // before setToken
        vm.prank(payer);
        d.notify{value: 4 ether}();
        assertEq(d.queued(), 7 ether);
        assertEq(d.rewardRate(), 0);
        skip(30 days);
        _setToken();
        skip(5 days);
        assertEq(d.queued(), 7 ether, "nothing streamed to nobody");
        _stake(alice, 1e18);
        assertEq(d.rewardRate(), 0, "a stake alone does not start the stream");
        assertTrue(d.canKick());
        d.kick(); // anyone; the stream starts now
        assertEq(d.periodFinish(), block.timestamp + 7 days);
        skip(7 days);
        assertApproxEqAbs(d.earned(alice), 7 ether, 1e6);
    }

    function test_everyone_unstakes_midstream_nothing_lost() public {
        _setToken();
        _stake(alice, 10e18);
        _send(7 ether);
        skip(3 days);
        vm.prank(alice);
        d.unstake(10e18);
        skip(2 days); // 2 days of stream with nobody staked -> queued, not lost
        assertApproxEqAbs(d.pending(), 4 ether, 1e6);
        skip(20 days); // well past the old periodFinish
        assertApproxEqAbs(d.pending(), 4 ether, 1e6);
        _stake(bob, 1e18);
        d.kick(); // restarts: 4 ETH over a fresh 7 days
        assertEq(d.periodFinish(), block.timestamp + 7 days);
        skip(7 days);
        assertApproxEqAbs(d.earned(bob), 4 ether, 1e6);
        assertApproxEqAbs(d.earned(alice), 3 ether, 1e6);
        vm.prank(alice);
        d.claim();
        vm.prank(bob);
        d.claim();
        assertLt(address(d).balance, 1e6, "only dust");
    }

    function test_notify_with_no_stakers_after_stream_queues() public {
        _setToken();
        _stake(alice, 1e18);
        _send(7 ether);
        skip(8 days);
        vm.prank(alice);
        d.unstake(1e18);
        _send(1 ether);
        assertApproxEqAbs(d.queued(), 1 ether, 1e6);
        _stake(bob, 1e18);
        d.kick();
        skip(7 days);
        assertApproxEqAbs(d.earned(bob), 1 ether, 1e6);
    }

    function test_zero_value_and_bad_amounts() public {
        _setToken();
        vm.expectRevert(BrimDrip.BadAmount.selector);
        d.notify{value: 0}();
        vm.prank(alice);
        vm.expectRevert(BrimDrip.BadAmount.selector);
        d.stake(0);
        vm.prank(alice);
        vm.expectRevert(BrimDrip.BadAmount.selector);
        d.unstake(1);
        vm.prank(alice);
        vm.expectRevert(BrimDrip.BadAmount.selector);
        d.claim();
    }

    // ─────────── reentrancy ───────────

    function test_reentrancy_on_claim_blocked() public {
        _setToken();
        Reenter r = new Reenter(d, brim);
        brim.mint(address(r), 10e18);
        r.doStake(10e18);
        _send(7 ether);
        skip(7 days);
        for (uint8 mode = 1; mode <= 3; ++mode) {
            r.setMode(mode); // nested claim / stake / notify all hit the guard -> send fails
            vm.expectRevert(BrimDrip.SendFailed.selector);
            r.doClaim();
        }
        r.setMode(0);
        r.doClaim();
        assertApproxEqAbs(address(r).balance, 7 ether, 1e6);
    }

    // ─────────── BrimVault fee path ───────────

    function test_vault_fee_reaches_drip() public {
        MockStock stk = new MockStock("NVDA");
        MockFeed feed = new MockFeed();
        uint256 t0 = 1_793_998_800 + 2 days; // Sun 08 Nov 2026 21:00 UTC
        vm.warp(t0);
        feed.pushNow(100e8);
        address[] memory ts = new address[](1);
        address[] memory fs = new address[](1);
        (ts[0], fs[0]) = (address(stk), address(feed));
        BrimVault v = new BrimVault(ts, fs, 100, address(d));
        stk.mint(alice, 10e18);
        uint64 exp = uint64(1_793_998_800 + 1 weeks);
        vm.startPrank(alice);
        stk.approve(address(v), 10e18);
        uint256 id = v.write(address(stk), 10e18, 110e8, exp, 1 ether);
        vm.stopPrank();
        vm.prank(payer);
        v.buy{value: 10 ether}(id, 10e18, 10 ether);
        uint80 r = feed.push(100e8, exp - 1 minutes);
        feed.push(100e8, exp + 1 minutes);
        vm.warp(exp + 1 hours);
        v.settle(id, r);
        v.withdrawEth(address(d));
        assertEq(address(d).balance, 0.1 ether);
        assertEq(d.queued(), 0.1 ether);
    }

    // ─────────── fuzz: conservation ───────────

    /// Random stakes / unstakes / payments / claims over time: the drip always holds at least what it owes
    /// (Σ earned + still to stream), and after everyone claims post-stream only dust remains.
    function testFuzz_conservation(uint256 seed) public {
        _setToken();
        address[3] memory us = [alice, bob, carol];
        uint256 paidIn;
        for (uint256 i; i < 25; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address u = us[r % 3];
            uint256 op = (r >> 8) % 5;
            if (op == 0) {
                _stake(u, bound(r >> 16, 1, 100e18));
            } else if (op == 1 && d.balanceOf(u) > 0) {
                uint256 a = bound(r >> 16, 1, d.balanceOf(u));
                vm.prank(u);
                d.unstake(a);
            } else if (op == 2) {
                uint256 a = (r >> 200) % 2 == 0 ? bound(r >> 16, 1, 0.004 ether) : bound(r >> 16, 1, 5 ether);
                paidIn += a;
                _send(a);
            } else if (op == 3 && d.earned(u) > 0) {
                vm.prank(u);
                d.claim();
            } else if (op == 4 && d.canKick()) {
                d.kick();
            }
            skip(bound(r >> 128, 0, 3 days));
            uint256 owed = d.earned(alice) + d.earned(bob) + d.earned(carol) + d.pending();
            assertGe(address(d).balance, owed, "solvent");
            assertLe(address(d).balance - owed, 1e9, "accounting tight");
        }
        if (d.totalStaked() == 0) _stake(alice, 1e18);
        if (d.canKick()) d.kick();
        skip(8 days);
        for (uint256 k; k < 3; ++k) {
            if (d.earned(us[k]) > 0) {
                vm.prank(us[k]);
                d.claim();
            }
        }
        assertLe(address(d).balance, d.queued() + 1e9, "only queued (< MIN_RESTART or remainder) + dust remain");
        assertLt(d.queued(), d.MIN_RESTART() + 7 days, "nothing startable left waiting");
        assertEq(alice.balance + bob.balance + carol.balance + address(d).balance, paidIn);
    }
}

contract Reenter {
    BrimDrip d;
    PlainToken t;
    uint8 public mode;

    constructor(BrimDrip d_, PlainToken t_) {
        (d, t) = (d_, t_);
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function doStake(uint256 a) external {
        t.approve(address(d), type(uint256).max);
        d.stake(a);
    }

    function doClaim() external {
        d.claim();
    }

    receive() external payable {
        if (mode == 1) d.claim();
        else if (mode == 2) d.stake(1);
        else if (mode == 3) d.notify{value: 1}();
    }
}
