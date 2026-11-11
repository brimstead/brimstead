// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IFeed {
    function decimals() external view returns (uint8);
    function phaseId() external view returns (uint16);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IStock {
    function oraclePaused() external view returns (bool);
    function effectiveAt() external view returns (uint256);
}

/// @title BrimVault - fully collateralized covered calls on Robinhood stock tokens, ETH premium held in escrow.
/// @notice No owner, no admin, no upgrade. Registry, fee and fee recipient are fixed at deploy. Unaudited. See SPEC.md.
contract BrimVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { Open, Settled, FellBack }

    struct Offer {
        address writer;
        uint64 expiry;
        Status status;
        bool writerClaimed;
        address token;
        uint256 strike; // feed units (USD per raw token, feed decimals)
        uint256 premiumPerToken; // wei per 1e18 token units
        uint256 available; // unsold tokens still locked
        uint256 sold; // tokens sold to buyers (locked until resolution)
        uint256 escrow; // ETH premium held until resolution
        uint256 price; // settlement price (0 unless Settled)
    }

    struct Position {
        uint256 offerId;
        address buyer;
        bool claimed;
        uint256 amount;
        uint256 premium;
    }

    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant MAX_PRICE_AGE = 26 hours; // write: heartbeat 24 h + margin
    uint256 public constant BUY_PRICE_AGE = 4 days; // buy: the anti pick-off check still works over a weekend
    uint256 public constant CLOSE_MAX_AGE = 26 hours; // the settlement (close) round must be >= expiry - 26 h
    uint256 public constant GRID_OFFSET = 45 hours; // Friday 21:00 UTC (1970-01-01 was a Thursday)
    uint256 public constant MIN_TENOR = 1 days;
    uint256 public constant MAX_TENOR = 28 days;
    uint256 public constant BUY_CUTOFF = 2 hours;
    uint256 public constant SETTLE_WINDOW = 4 days; // fallback earliest at expiry + 4 days (room for round r+1)
    uint256 public constant LONG_STOP = 30 days; // fallback always allowed after this
    uint256 public constant ACTION_MARGIN = 1 days; // corporate-action guard around closeRound..expiry

    uint256 public immutable feeBps;
    address public immutable feeRecipient;

    mapping(address token => address feed) public feedOf;
    address[] public tokens;
    Offer[] internal _offers;
    Position[] internal _positions;
    mapping(address account => uint256) public ethOwed;

    event Listed(address indexed token, address indexed feed);
    event Written(uint256 indexed offerId, address indexed writer, address indexed token, uint256 amount, uint256 strike, uint64 expiry, uint256 premiumPerToken);
    event Bought(uint256 indexed offerId, uint256 indexed positionId, address indexed buyer, uint256 amount, uint256 premium);
    event Cancelled(uint256 indexed offerId, uint256 amount, uint256 remaining);
    event Settled(uint256 indexed offerId, uint80 roundId, uint256 price, uint256 writerEth, uint256 fee);
    event FellBack(uint256 indexed offerId, uint8 reason);
    event BuyerClaimed(uint256 indexed positionId, address indexed buyer, uint256 tokens, uint256 eth);
    event WriterClaimed(uint256 indexed offerId, address indexed writer, uint256 tokens);
    event EthCredited(address indexed account, uint256 amount);
    event EthPaid(address indexed account, uint256 amount);

    error BadConfig(); error UnknownToken(); error BadAmount(); error BadStrike(); error BadExpiry();
    error BadPrice(); error FeeOnTransfer(); error NotWriter(); error NotOpen(); error BuyClosed();
    error PremiumTooHigh(uint256 premium); error TooEarly(); error BadRound(); error IssuerHold();
    error NotEligible(); error AlreadyClaimed(); error RefundFailed(); error InTheMoney();

    constructor(address[] memory tokens_, address[] memory feeds, uint256 feeBps_, address feeRecipient_) {
        if (tokens_.length != feeds.length || feeBps_ > MAX_FEE_BPS || feeRecipient_ == address(0)) revert BadConfig();
        for (uint256 i; i < tokens_.length; ++i) {
            (address t, address f) = (tokens_[i], feeds[i]);
            if (t.code.length == 0 || f.code.length == 0 || feedOf[t] != address(0) || IFeed(f).decimals() == 0) revert BadConfig();
            feedOf[t] = f;
            tokens.push(t);
            emit Listed(t, f);
        }
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    // ───────────────────────── writer ─────────────────────────

    function write(address token, uint256 amount, uint256 strike, uint64 expiry, uint256 premiumPerToken)
        external
        nonReentrant
        returns (uint256 offerId)
    {
        address feed = feedOf[token];
        if (feed == address(0)) revert UnknownToken();
        if (amount == 0) revert BadAmount();
        if (
            expiry % 1 weeks != GRID_OFFSET || expiry < block.timestamp + MIN_TENOR
                || expiry > block.timestamp + MAX_TENOR
        ) revert BadExpiry();
        (, int256 px,, uint256 upd,) = IFeed(feed).latestRoundData();
        if (px <= 0 || upd > block.timestamp || block.timestamp - upd > MAX_PRICE_AGE || _oraclePaused(token)) {
            revert BadPrice();
        }
        if (strike <= uint256(px)) revert BadStrike(); // strictly OTM, so every offer is buyable at write time

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert FeeOnTransfer();

        offerId = _offers.length;
        _offers.push(Offer(msg.sender, expiry, Status.Open, false, token, strike, premiumPerToken, amount, 0, 0, 0));
        emit Written(offerId, msg.sender, token, amount, strike, expiry, premiumPerToken);
    }

    /// @notice Withdraw unsold tokens, at any time (also after expiry).
    function cancel(uint256 offerId, uint256 amount) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (msg.sender != o.writer) revert NotWriter();
        if (amount == 0 || amount > o.available) revert BadAmount();
        o.available -= amount;
        IERC20(o.token).safeTransfer(o.writer, amount);
        emit Cancelled(offerId, amount, o.available);
    }

    // ───────────────────────── buyer ─────────────────────────

    function buy(uint256 offerId, uint256 amount, uint256 maxPremium) external payable nonReentrant returns (uint256 positionId) {
        Offer storage o = _offers[offerId];
        if (block.timestamp + BUY_CUTOFF >= o.expiry) revert BuyClosed();
        if (amount == 0 || amount > o.available) revert BadAmount();
        (, int256 px,, uint256 upd,) = IFeed(feedOf[o.token]).latestRoundData();
        if (px <= 0 || upd > block.timestamp || block.timestamp - upd > BUY_PRICE_AGE || _oraclePaused(o.token)) {
            revert BadPrice();
        }
        if (uint256(px) >= o.strike) revert InTheMoney(); // anti pick-off: only out-of-the-money calls can be bought
        uint256 premium = Math.mulDiv(amount, o.premiumPerToken, 1e18, Math.Rounding.Ceil);
        if (premium > maxPremium || premium > msg.value) revert PremiumTooHigh(premium);
        o.available -= amount;
        o.sold += amount;
        o.escrow += premium;
        positionId = _positions.length;
        _positions.push(Position(offerId, msg.sender, false, amount, premium));
        emit Bought(offerId, positionId, msg.sender, amount, premium);
        if (msg.value > premium) {
            (bool ok,) = msg.sender.call{value: msg.value - premium}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ───────────────────────── resolution ─────────────────────────

    /// @notice Settle at the Friday close: the LAST round of the feed's current phase with updatedAt <= expiry, proven
    ///         by round + 1 (same phase) having updatedAt > expiry; the close must be >= expiry - CLOSE_MAX_AGE.
    function settle(uint256 offerId, uint80 roundId) external nonReentrant {
        Offer storage o = _open(offerId);
        (uint8 kind, uint256 px, uint256 upd) = _lastBefore(feedOf[o.token], o.expiry, roundId);
        if (kind != 1 || upd + CLOSE_MAX_AGE < o.expiry) revert BadRound();
        if (_issuerHold(o.token, o.expiry, upd)) revert IssuerHold();
        o.status = Status.Settled;
        o.price = px;
        uint256 fee = (o.escrow * feeBps) / 10_000;
        uint256 toWriter = o.escrow - fee;
        _credit(o.writer, toWriter);
        _credit(feeRecipient, fee);
        emit Settled(offerId, roundId, px, toWriter, fee);
    }

    /// @notice After expiry + SETTLE_WINDOW, when settlement is provably impossible (or after LONG_STOP): buyers get
    ///         their premium back in full (no fee), the writer gets every token back. `roundId` is a hint for reason 3.
    function settleFallback(uint256 offerId, uint80 roundId) external nonReentrant {
        Offer storage o = _open(offerId);
        if (block.timestamp < o.expiry + SETTLE_WINDOW) revert TooEarly();
        address feed = feedOf[o.token];
        uint8 reason;
        if (block.timestamp >= o.expiry + LONG_STOP) reason = 4;
        else if (_oraclePaused(o.token)) reason = 1;
        else if (_latestUpdatedAt(feed) <= o.expiry) reason = 2; // no round after expiry: r + 1 cannot be shown
        else {
            (uint8 kind,, uint256 upd) = _lastBefore(feed, o.expiry, roundId);
            if (kind == 2) reason = 3; // the current phase began after expiry: no in-phase close round
            else if (kind == 1 && upd + CLOSE_MAX_AGE < o.expiry) reason = 3; // close too old (market holiday)
            else if (kind == 1 && _issuerHold(o.token, o.expiry, upd)) reason = 1; // corporate action
            else revert NotEligible();
        }
        o.status = Status.FellBack;
        emit FellBack(offerId, reason);
    }

    // ───────────────────────── claims (pull) ─────────────────────────

    function claimBuyer(uint256 positionId) external nonReentrant {
        Position storage p = _positions[positionId];
        Offer storage o = _offers[p.offerId];
        if (o.status == Status.Open) revert NotOpen();
        if (p.claimed) revert AlreadyClaimed();
        p.claimed = true;
        uint256 tokensOut;
        uint256 ethOut;
        if (o.status == Status.Settled) {
            tokensOut = _itm(p.amount, o.price, o.strike);
            if (tokensOut != 0) IERC20(o.token).safeTransfer(p.buyer, tokensOut);
        } else {
            ethOut = p.premium;
            _pay(p.buyer, ethOut);
        }
        emit BuyerClaimed(positionId, p.buyer, tokensOut, ethOut);
    }

    /// @notice Returns the writer's share of the sold tokens plus any unsold remainder. Anyone may call it.
    function claimWriter(uint256 offerId) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.status == Status.Open) revert NotOpen();
        if (o.writerClaimed) revert AlreadyClaimed();
        o.writerClaimed = true;
        uint256 out = o.sold + o.available;
        if (o.status == Status.Settled) out -= _itm(o.sold, o.price, o.strike);
        o.available = 0;
        if (out != 0) IERC20(o.token).safeTransfer(o.writer, out);
        emit WriterClaimed(offerId, o.writer, out);
    }

    /// @notice Pay out credited ETH (writer premium, fee, failed refunds). Anyone may trigger it for `account`.
    function withdrawEth(address account) external nonReentrant {
        uint256 amt = ethOwed[account];
        if (amt == 0) revert BadAmount();
        ethOwed[account] = 0;
        (bool ok,) = account.call{value: amt}("");
        if (!ok) revert RefundFailed();
        emit EthPaid(account, amt);
    }

    /// @notice Pull your own credited ETH to another address (for accounts that cannot receive ETH, review L-3).
    function withdrawEthTo(address to) external nonReentrant {
        uint256 amt = ethOwed[msg.sender];
        if (amt == 0 || to == address(0)) revert BadAmount();
        ethOwed[msg.sender] = 0;
        (bool ok,) = to.call{value: amt}("");
        if (!ok) revert RefundFailed();
        emit EthPaid(msg.sender, amt);
    }

    // ───────────────────────── views ─────────────────────────

    function offer(uint256 id) external view returns (Offer memory) { return _offers[id]; }
    function position(uint256 id) external view returns (Position memory) { return _positions[id]; }
    function offerCount() external view returns (uint256) { return _offers.length; }
    function positionCount() external view returns (uint256) { return _positions.length; }
    function tokenCount() external view returns (uint256) { return tokens.length; }

    /// @notice Tokens a position of `amount` receives at settlement price `price` (rounded down).
    function payoutOf(uint256 amount, uint256 price, uint256 strike) external pure returns (uint256) {
        return _itm(amount, price, strike);
    }

    // ───────────────────────── internal ─────────────────────────

    function _itm(uint256 amount, uint256 price, uint256 strike) internal pure returns (uint256) {
        return price > strike ? Math.mulDiv(amount, price - strike, price) : 0;
    }

    function _open(uint256 offerId) internal view returns (Offer storage o) {
        o = _offers[offerId];
        if (o.status != Status.Open) revert NotOpen();
        if (block.timestamp < o.expiry) revert TooEarly();
    }

    /// @dev kind 1: `roundId` is in the feed's current phase, answer > 0, updatedAt <= expiry, and round + 1 exists
    ///      with updatedAt > expiry (so it is the last round at or before expiry). kind 2: `roundId` is round 1 of the
    ///      current phase and printed after expiry (the phase began after expiry). kind 0: anything else.
    function _lastBefore(address feed, uint64 expiry, uint80 roundId) internal view returns (uint8, uint256, uint256) {
        uint64 agg = uint64(roundId);
        if (agg == 0 || agg == type(uint64).max) return (0, 0, 0);
        try IFeed(feed).phaseId() returns (uint16 ph) {
            if (roundId >> 64 != ph) return (0, 0, 0);
        } catch {
            return (0, 0, 0);
        }
        (int256 a, uint256 upd) = _round(feed, roundId);
        if (a <= 0 || upd == 0) return (0, 0, 0);
        if (upd > expiry) return (agg == 1 ? 2 : 0, 0, upd);
        (, uint256 next) = _round(feed, roundId + 1);
        if (next <= expiry) return (0, 0, 0); // missing (0) or not after expiry
        return (1, uint256(a), upd);
    }

    function _round(address feed, uint80 id) internal view returns (int256, uint256) {
        try IFeed(feed).getRoundData(id) returns (uint80 rid, int256 a, uint256, uint256 u, uint80) {
            if (rid == id) return (a, u);
        } catch {}
        return (0, 0);
    }

    function _latestUpdatedAt(address feed) internal view returns (uint256) {
        try IFeed(feed).latestRoundData() returns (uint80, int256, uint256, uint256 u, uint80) {
            return u;
        } catch {
            return type(uint256).max; // unknown: reason 2 not provable (LONG_STOP still applies)
        }
    }

    /// @dev Issuer says "do not use the feed", or a uiMultiplier change is scheduled within
    ///      (closeUpdatedAt - ACTION_MARGIN, expiry + ACTION_MARGIN).
    function _issuerHold(address token, uint64 expiry, uint256 upd) internal view returns (bool) {
        if (_oraclePaused(token)) return true;
        (bool ok, bytes memory d) = token.staticcall(abi.encodeCall(IStock.effectiveAt, ()));
        if (!ok || d.length < 32) return false;
        uint256 eff = abi.decode(d, (uint256));
        return eff != 0 && eff + ACTION_MARGIN > upd && eff < expiry + ACTION_MARGIN;
    }

    function _oraclePaused(address token) internal view returns (bool) {
        (bool ok, bytes memory d) = token.staticcall(abi.encodeCall(IStock.oraclePaused, ()));
        return ok && d.length >= 32 && abi.decode(d, (bool));
    }

    function _credit(address account, uint256 amt) internal {
        if (amt == 0) return;
        ethOwed[account] += amt;
        emit EthCredited(account, amt);
    }

    /// @dev Safe send: try to pay now, otherwise credit for withdrawEth.
    function _pay(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok,) = to.call{value: amt}("");
        if (ok) emit EthPaid(to, amt);
        else _credit(to, amt);
    }
}
