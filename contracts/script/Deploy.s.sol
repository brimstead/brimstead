// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BrimVault, IFeed} from "../src/BrimVault.sol";
import {BrimDrip} from "../src/BrimDrip.sol";
import {LaunchSet} from "./LaunchSet.sol";

/// Deploys BrimDrip, then BrimVault with feeRecipient = BrimDrip. Parameters (env, all optional):
///   FEE_BPS        0..100, default 100 (1 %, immutable)
///   TOKENS, FEEDS  comma-separated address lists (same length); default = script/LaunchSet.sol
///   CHAIN_ID       expected chain id, default 4663 (RC mainnet)
/// The broadcasting account becomes BrimDrip's deployer: the only address that can call setToken($BRIM), once.
/// Dry run:  forge script script/Deploy.s.sol --rpc-url mainnet_archive
/// Deploy (humans only): add --broadcast --account <keystore>
contract Deploy is Script {
    function run() external returns (BrimDrip drip, BrimVault vault) {
        require(block.chainid == vm.envOr("CHAIN_ID", uint256(4663)), "wrong chain");
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(100));
        require(feeBps <= 100, "fee cap");

        (, address[] memory tokens, address[] memory feeds) = LaunchSet.list();
        if (vm.envExists("TOKENS")) {
            tokens = vm.envAddress("TOKENS", ",");
            feeds = vm.envAddress("FEEDS", ",");
        }
        require(tokens.length == feeds.length && tokens.length > 0, "registry length");
        for (uint256 i; i < tokens.length; ++i) {
            require(IERC20Metadata(tokens[i]).decimals() == 18, "token decimals");
            require(IFeed(feeds[i]).decimals() == 8, "feed decimals");
            (, int256 a,, uint256 upd,) = IFeed(feeds[i]).latestRoundData();
            require(a > 0 && upd > 0, "feed dead");
            console.log(IERC20Metadata(tokens[i]).symbol(), feeds[i], uint256(a));
        }

        vm.startBroadcast();
        drip = new BrimDrip();
        vault = new BrimVault(tokens, feeds, feeBps, address(drip));
        vm.stopBroadcast();

        require(vault.feeRecipient() == address(drip) && vault.feeBps() == feeBps, "wiring");
        console.log("BrimDrip", address(drip), "deployer (setToken once)", drip.deployer());
        console.log("BrimVault", address(vault), "feeBps", feeBps);
    }
}
