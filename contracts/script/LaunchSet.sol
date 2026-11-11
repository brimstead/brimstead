// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Robinhood stock tokens + Chainlink proxies on RC mainnet (4663), verified with cast on 11-11-2026
///         (block ~111.46M): every token symbol() as listed, decimals() 18, oraclePaused() false, paused() false;
///         every feed decimals() 8, phaseId() 1, description() as noted, last print < 14 h old.
///         Feeds price USD per RAW token (share price x uiMultiplier). SGOV (T-bill ETF, heartbeat-only prints) is
///         deliberately left out.
library LaunchSet {
    uint256 internal constant N = 11;

    function list() internal pure returns (string[] memory sym, address[] memory tok, address[] memory feed) {
        sym = new string[](N);
        tok = new address[](N);
        feed = new address[](N);
        (sym[0], tok[0], feed[0]) = ("NVDA", 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15); // RHNVDA / USD
        (sym[1], tok[1], feed[1]) = ("TSLA", 0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 0x4A1166a659A55625345e9515b32adECea5547C38); // RHTSLA / USD
        (sym[2], tok[2], feed[2]) = ("AAPL", 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0); // Robinhood AAPL / USD
        (sym[3], tok[3], feed[3]) = ("SPY", 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 0x319724394D3A0e3669269846abE664Cd621f9f6A); // RHSPY / USD
        (sym[4], tok[4], feed[4]) = ("QQQ", 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 0x80901d846d5D7B030F26B480776EE3b29374C2ae); // Robinhood QQQ / USD
        (sym[5], tok[5], feed[5]) = ("MSFT", 0xe93237C50D904957Cf27E7B1133b510C669c2e74, 0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E); // RHMSFT / USD
        (sym[6], tok[6], feed[6]) = ("AMZN", 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C); // Robinhood AMZN / USD
        (sym[7], tok[7], feed[7]) = ("GOOGL", 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, 0xF6f373a037c30F0e5010d854385cA89185AE638b); // Robinhood GOOGL / USD
        (sym[8], tok[8], feed[8]) = ("GLD", 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e, 0x470A51258068043bd43dC0a56245625C9fE86eB0); // GLD / USD
        (sym[9], tok[9], feed[9]) = ("SPCX", 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb); // Robinhood SPCX / USD
        (sym[10], tok[10], feed[10]) = ("MSTR", 0xec262a75e413fAfD0dF80480274532C79D42da09, 0x396118bdFB181e6240E74D243F266B061c0edc3D); // Robinhood MSTR / USD
    }
}
