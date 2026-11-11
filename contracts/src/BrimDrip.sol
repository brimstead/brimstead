// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BrimDrip - stake $BRIM, earn the ETH sent here (BrimVault fees, manual creator-fee transfers), streamed
///        linearly over 7 days (Synthetix rewardRate).
/// @notice Incoming ETH is queued. A new 7-day stream (leftover + queued) starts only when queued >= MIN_RESTART,
///         somebody stakes and the token is set: on the payment that crosses the threshold, or via `kick()` (anyone).
///         Dust cannot keep pushing the stream back. No owner: the deployer may call `setToken` exactly once and has
///         no other power. Unaudited.
contract BrimDrip is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DURATION = 7 days;
    uint256 public constant MIN_RESTART = 0.005 ether;

    address public immutable deployer;
    IERC20 public token;

    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;

    uint256 public rewardRate; // wei per second
    uint256 public periodFinish;
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored; // 1e36-scaled wei per staked unit (review L-5)
    uint256 public queued; // ETH waiting to be streamed (below MIN_RESTART, no stakers, token unset, or remainder)
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event TokenSet(address indexed token);
    event Notified(address indexed from, uint256 amount, uint256 queued);
    event StreamStarted(uint256 amount, uint256 rewardRate, uint256 periodFinish);
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);

    error NotDeployer();
    error TokenAlreadySet();
    error TokenNotSet();
    error BadToken();
    error BadAmount();
    error FeeOnTransfer();
    error SendFailed();
    error NotReady();

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One shot: the $BRIM token address, set by the deployer after launch. Locked afterwards.
    function setToken(address token_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(token) != address(0)) revert TokenAlreadySet();
        if (token_.code.length == 0) revert BadToken();
        token = IERC20(token_);
        emit TokenSet(token_);
    }

    receive() external payable {
        _notify();
    }

    function notify() external payable {
        _notify();
    }

    /// @notice Start a new 7-day stream of leftover + queued when queued >= MIN_RESTART, there are stakers and the
    ///         token is set (e.g. after the first stake, or once small payments added up). Anyone.
    function kick() external nonReentrant {
        _update(address(0));
        if (!_tryStart()) revert NotReady();
    }

    function stake(uint256 amount) external nonReentrant {
        if (address(token) == address(0)) revert TokenNotSet();
        if (amount == 0) revert BadAmount();
        _update(msg.sender);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert FeeOnTransfer();
        totalStaked += amount;
        balanceOf[msg.sender] += amount;
        emit Staked(msg.sender, amount); // queued ETH starts with the next qualifying payment or kick()
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > balanceOf[msg.sender]) revert BadAmount();
        _update(msg.sender);
        balanceOf[msg.sender] -= amount;
        totalStaked -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant returns (uint256 amt) {
        _update(msg.sender);
        amt = rewards[msg.sender];
        if (amt == 0) revert BadAmount();
        rewards[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert SendFailed();
        emit Claimed(msg.sender, amt);
    }

    // ───────────────────────── views ─────────────────────────

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        uint256 t = lastTimeRewardApplicable();
        if (totalStaked == 0 || t <= lastUpdate) return rewardPerTokenStored;
        return rewardPerTokenStored + ((t - lastUpdate) * rewardRate * 1e36) / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return rewards[account]
            + (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e36;
    }

    function canKick() public view returns (bool) {
        uint256 q = queued;
        if (totalStaked == 0) {
            uint256 t = lastTimeRewardApplicable();
            if (t > lastUpdate) q += (t - lastUpdate) * rewardRate;
        }
        return address(token) != address(0) && totalStaked > 0 && q >= MIN_RESTART;
    }

    /// @notice ETH still to be streamed (current stream remainder + queued).
    function pending() external view returns (uint256) {
        uint256 left = block.timestamp < periodFinish ? (periodFinish - block.timestamp) * rewardRate : 0;
        uint256 idle;
        if (totalStaked == 0) {
            uint256 t = lastTimeRewardApplicable();
            if (t > lastUpdate) idle = (t - lastUpdate) * rewardRate;
        }
        return left + queued + idle;
    }

    // ───────────────────────── internal ─────────────────────────

    function _notify() internal nonReentrant {
        if (msg.value == 0) revert BadAmount();
        _update(address(0));
        queued += msg.value;
        emit Notified(msg.sender, msg.value, queued);
        _tryStart();
    }

    /// @dev Accrue the stream. While nobody stakes, the elapsed part of the stream is moved to `queued` (not lost).
    function _update(address account) internal {
        uint256 t = lastTimeRewardApplicable();
        if (totalStaked == 0) {
            if (t > lastUpdate) queued += (t - lastUpdate) * rewardRate;
        } else {
            rewardPerTokenStored = rewardPerToken();
        }
        lastUpdate = block.timestamp;
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    function _tryStart() internal returns (bool) {
        if (address(token) == address(0) || totalStaked == 0 || queued < MIN_RESTART) return false;
        _restart();
        return true;
    }

    /// @dev New stream = leftover + queued over DURATION; the division remainder stays queued. Call after _update.
    function _restart() internal {
        uint256 left = block.timestamp < periodFinish ? (periodFinish - block.timestamp) * rewardRate : 0;
        uint256 total = left + queued;
        rewardRate = total / DURATION;
        queued = total - rewardRate * DURATION;
        lastUpdate = block.timestamp;
        periodFinish = block.timestamp + DURATION;
        emit StreamStarted(total, rewardRate, periodFinish);
    }
}
