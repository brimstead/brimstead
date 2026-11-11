// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Robinhood-stock-like token: issuer can pause, block addresses, set oraclePaused / effectiveAt.
contract MockStock is ERC20 {
    bool public paused;
    bool public oraclePaused;
    uint256 public effectiveAt;
    mapping(address => bool) public isBlocked;

    constructor(string memory s) ERC20(s, s) {}

    function mint(address to, uint256 a) external { _mint(to, a); }
    function setPaused(bool p) external { paused = p; }
    function setOraclePaused(bool p) external { oraclePaused = p; }
    function setEffectiveAt(uint256 t) external { effectiveAt = t; }
    function setBlocked(address a, bool b) external { isBlocked[a] = b; }

    function _update(address from, address to, uint256 v) internal override {
        require(!paused, "paused");
        require(!isBlocked[from] && !isBlocked[to], "blocked");
        super._update(from, to, v);
    }
}

/// A plain ERC-20 without the issuer views (guards must tolerate their absence).
contract PlainToken is ERC20 {
    constructor() ERC20("P", "P") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract FeeToken is ERC20 {
    constructor() ERC20("F", "F") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) {
            super._update(from, address(0xdead), v / 100);
            v -= v / 100;
        }
        super._update(from, to, v);
    }
}

/// Chainlink proxy with phases: id = phase << 64 | agg. A missing round of an existing phase returns zeros; a round
/// of an unknown phase reverts (as on RC mainnet).
contract MockFeed {
    struct R { int256 a; uint256 u; }
    uint8 public decimals = 8;
    uint16 public phaseId = 1;
    mapping(uint16 => uint64) public lastAgg;
    mapping(uint16 => mapping(uint64 => R)) internal _r;

    function push(int256 a, uint256 u) public returns (uint80 id) {
        uint64 n = ++lastAgg[phaseId];
        _r[phaseId][n] = R(a, u);
        return (uint80(phaseId) << 64) | n;
    }
    function pushNow(int256 a) external returns (uint80) { return push(a, block.timestamp); }
    function newPhase() external { phaseId++; }
    function skipRound() external { ++lastAgg[phaseId]; } // a gap: a round that reads as zeros

    function getRoundData(uint80 id) public view returns (uint80, int256, uint256, uint256, uint80) {
        uint16 ph = uint16(id >> 64);
        require(ph != 0 && ph <= phaseId, "no phase");
        R memory r = _r[ph][uint64(id)];
        if (r.u == 0) return (0, 0, 0, 0, 0);
        return (id, r.a, r.u, r.u, id);
    }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData((uint80(phaseId) << 64) | lastAgg[phaseId]);
    }
}

contract Rejecter {
    receive() external payable { revert("no"); }
    function call(address t, bytes calldata d) external payable returns (bytes memory) {
        (bool ok, bytes memory r) = t.call{value: msg.value}(d);
        require(ok, "call failed");
        return r;
    }
}
