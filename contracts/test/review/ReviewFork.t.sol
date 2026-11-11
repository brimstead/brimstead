// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BrimVault, IFeed} from "../../src/BrimVault.sol";
import {LaunchSet} from "../../script/LaunchSet.sol";

interface IProxy {
    function description() external view returns (string memory);
    function aggregator() external view returns (address);
}

interface ITV {
    function typeAndVersion() external view returns (string memory);
}

contract ReviewHarness is BrimVault {
    constructor(address[] memory t, address[] memory f, uint256 b, address r) BrimVault(t, f, b, r) {}
    function forceExpiry(uint256 id, uint64 e) external { _offers[id].expiry = e; }
    function forceStrike(uint256 id, uint256 k) external { _offers[id].strike = k; }
}

/// Independent review on an RC mainnet fork (archive RPC): the real feeds are Chainlink DualAggregator (SVR)
/// behind standard proxies. Checks the round-proof assumptions the vault relies on.
contract ReviewForkTest is Test {
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    uint80 constant PH = uint80(1) << 64;
    uint64 constant FRI_06_NOV = 1_793_998_800;
    bool noFork;

    function setUp() public {
        if (vm.envOr("SKIP_FORK", false)) { noFork = true; return; }
        vm.createSelectFork(vm.envOr("FORK_RPC", string("https://robinhood.drpc.org")), vm.envOr("FORK_BLOCK", uint256(111_464_891)));
    }

    /// Ids within phase 1 are consecutive and updatedAt is monotonic around a real weekend close; a not-yet-printed
    /// round, a uint32-aliased id and round 0 come back with a DIFFERENT round id (so _round() returns zeros), and
    /// an unknown phase reverts.
    function test_review_fork_round_semantics() public view {
        if (noFork) return;
        assertEq(ITV(IProxy(TSLA_FEED).aggregator()).typeAndVersion(), "DualAggregator 1.0.0");
        uint256 prev;
        for (uint64 n = 2015; n <= 2030; ++n) {
            (uint80 rid, int256 a,, uint256 u,) = IFeed(TSLA_FEED).getRoundData(PH | n);
            assertEq(rid, PH | n, "consecutive ids");
            assertGt(a, 0);
            assertGe(u, prev, "monotonic updatedAt");
            prev = u;
        }
        (uint80 latest,,,,) = IFeed(TSLA_FEED).latestRoundData();
        (uint80 r1,,, uint256 u1,) = IFeed(TSLA_FEED).getRoundData(latest + 1);
        assertTrue(r1 != latest + 1 && u1 == 0, "future round reads as other id + zeros");
        (uint80 r2,,,,) = IFeed(TSLA_FEED).getRoundData(PH | ((uint80(1) << 32) + 2025));
        assertTrue(r2 != (PH | ((uint80(1) << 32) + 2025)), "uint32 alias rejected by id check");
        (uint80 r3,,,,) = IFeed(TSLA_FEED).getRoundData(PH);
        assertTrue(r3 == PH, "round 0 echoes id with zeros (vault rejects agg == 0 itself)");
        try IFeed(TSLA_FEED).getRoundData((uint80(2) << 64) | 1) {
            revert("phase 2 should revert");
        } catch {}
    }

    /// The vault rejects an aliased id that maps onto the real close round.
    function test_review_fork_settle_rejects_alias_and_accepts_close() public {
        if (noFork) return;
        address[] memory t = new address[](1);
        address[] memory f = new address[](1);
        (t[0], f[0]) = (TSLA, TSLA_FEED);
        ReviewHarness v = new ReviewHarness(t, f, 100, makeAddr("drip"));
        (, int256 a,, uint256 upd,) = IFeed(TSLA_FEED).latestRoundData();
        if (block.timestamp > upd + 20 hours) vm.warp(upd + 1 hours);
        uint256 nowTs = upd + 1 hours > block.timestamp ? upd + 1 hours : block.timestamp;
        uint256 tt = nowTs + 1 days;
        uint64 e = uint64(tt - (tt % 1 weeks) + 45 hours);
        if (e < tt) e += 1 weeks;
        address w = makeAddr("w");
        deal(TSLA, w, 1e18);
        vm.startPrank(w);
        IERC20(TSLA).approve(address(v), 1e18);
        uint256 id = v.write(TSLA, 1e18, uint256(a) + 1, e, 0);
        vm.stopPrank();
        v.forceExpiry(id, FRI_06_NOV);
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, PH | ((uint80(1) << 32) + 2025));
        vm.expectRevert(BrimVault.BadRound.selector);
        v.settle(id, PH | ((uint80(1) << 32) + 2024));
        v.settle(id, PH | 2025);
        assertEq(v.offer(id).price, 35825682500);
    }

    /// Every launch pair: the feed description names the token symbol.
    function test_review_fork_pairs_match() public view {
        if (noFork) return;
        (string[] memory s, address[] memory t, address[] memory f) = LaunchSet.list();
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20Metadata(t[i]).symbol(), s[i]);
            string memory d = IProxy(f[i]).description();
            assertTrue(_contains(d, s[i]), d);
            assertEq(IFeed(f[i]).decimals(), 8);
        }
    }

    function _contains(string memory h, string memory n) internal pure returns (bool) {
        bytes memory a = bytes(h);
        bytes memory b = bytes(n);
        for (uint256 i; i + b.length <= a.length; ++i) {
            bool ok = true;
            for (uint256 j; j < b.length; ++j) if (a[i + j] != b[j]) { ok = false; break; }
            if (ok) return true;
        }
        return false;
    }
}
