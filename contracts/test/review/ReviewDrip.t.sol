// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrimDrip} from "../../src/BrimDrip.sol";
import {PlainToken} from "../mocks/Mocks.sol";

/// Independent review: proofs for REVIEW.md findings (drip).
contract ReviewDripTest is Test {
    BrimDrip d;
    PlainToken brim;
    address deployer = makeAddr("deployer");
    address alice = makeAddr("alice");
    address poker = makeAddr("poker");

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.prank(deployer);
        d = new BrimDrip();
        brim = new PlainToken();
        vm.prank(deployer);
        d.setToken(address(brim));
        vm.deal(poker, 1 ether);
        vm.deal(address(this), 10 ether);
    }

    function _run(uint256 staked, uint256 stream, uint256 pokeEvery) internal returns (uint256 earned) {
        brim.mint(alice, staked);
        vm.startPrank(alice);
        brim.approve(address(d), staked);
        d.stake(staked);
        vm.stopPrank();
        d.notify{value: stream}(); // starts the 7-day stream
        uint256 t = 1_800_000_000; // explicit clock (via_ir caches block.timestamp across vm.warp)
        uint256 window = 6 hours; // measure a 6-hour window
        if (pokeEvery == 0) {
            vm.warp(t + window);
        } else {
            for (uint256 dt = pokeEvery; dt <= window; dt += pokeEvery) {
                vm.warp(t + dt);
                vm.prank(poker);
                d.notify{value: 1}(); // 1-wei dust: no restart, but it checkpoints rewardPerTokenStored
            }
        }
        earned = d.earned(alice);
    }

    /// LOW (L-5): rewardPerToken is 1e18-scaled. With a large staked supply (1e12 tokens x 1e18) and a minimum
    /// stream (0.005 ETH / 7 days), each checkpoint floors away almost the whole increment. A 1-wei notify every
    /// 60 s makes stakers earn ~0 (measured over 6 h); the ETH stays in the contract, unaccounted, forever.
    function test_review_precision_griefing_large_supply() public {
        uint256 snap = vm.snapshotState();
        uint256 honest = _run(1e30, 0.005 ether, 0);
        vm.revertToState(snap);
        uint256 griefed = _run(1e30, 0.005 ether, 60);
        emit log_named_uint("earned without pokes", honest);
        emit log_named_uint("earned with 1-wei pokes every 60 s", griefed);
        assertGt(honest, 0.00017 ether); // ~0.005 ETH * 6 h / 168 h
        // after L-5 fix (1e36 scale): griefing loses < 0.1 % of the stream
        assertGt(griefed, honest * 999 / 1000, "L-5 regression: precision loss under 1-wei pokes");
    }

    /// INFO: with a typical 1e9 x 1e18 supply the same griefing is negligible.
    function test_review_precision_typical_supply() public {
        uint256 griefed = _run(1e27, 0.005 ether, 60);
        assertGt(griefed, 0.00017 ether);
    }
}
