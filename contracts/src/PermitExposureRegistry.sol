// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Permit Exposure Registry
/// @notice Checks on chain whether a token accepts ECDSA-signed approvals (EIP-2612 / DAI-style `permit`).
///         On QoreChain a leaked ECDSA key cannot send an EVM transaction (that needs an ML-DSA-87 window),
///         but it CAN sign a permit that anyone else relays. Such a token is "exposed" at Q-Day.
///         Also reports the account's post-quantum key status, and records checks on chain.
contract PermitExposureRegistry {
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    // ---- flags
    uint16 public constant HAS_CODE = 1 << 0;
    uint16 public constant EIP2612_SELECTOR_IN_CODE = 1 << 1; // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
    uint16 public constant DAI_PERMIT_SELECTOR_IN_CODE = 1 << 2; // permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)
    uint16 public constant DOMAIN_SEPARATOR_CALLABLE = 1 << 3; // works through proxies
    uint16 public constant NONCES_CALLABLE = 1 << 4;
    uint16 public constant EIP712_DOMAIN_CALLABLE = 1 << 5; // ERC-5267
    uint16 public constant PQC_KEY_REGISTERED = 1 << 6;
    uint16 public constant PQC_ALG_MLDSA87 = 1 << 7;
    uint16 public constant PQC_POSSESSION_PROVEN = 1 << 8;
    uint16 public constant EIP3009_SELECTOR_IN_CODE = 1 << 9; // transfer/receiveWithAuthorization (USDC-style)

    /// Token bits (everything except the account's PQC bits 6-8).
    uint16 public constant TOKEN_MASK = 0x023F;
    uint16 public constant ACCOUNT_MASK = 0x01C0;

    uint16 public constant EXPOSURE_MASK =
        EIP2612_SELECTOR_IN_CODE | DAI_PERMIT_SELECTOR_IN_CODE | DOMAIN_SEPARATOR_CALLABLE | EIP3009_SELECTOR_IN_CODE;

    struct Check {
        address account;
        address token;
        uint16 flags;
        uint64 timestamp;
    }

    Check[] private checks;
    mapping(address account => uint256) public checksBy;

    event Checked(address indexed account, address indexed token, uint16 flags, bool exposed);

    // ------------------------------------------------------------------ views

    /// @notice Inspect `token` and `account` without writing anything.
    function scan(address token, address account) public view returns (uint16 flags) {
        if (token.code.length > 0) {
            flags |= HAS_CODE;
            if (_codeHasPush4(token, 0xd505accf) || _codeHasPush4(token, 0x9fd5a6cf)) flags |= EIP2612_SELECTOR_IN_CODE; // permit(…,v,r,s) / permit(…,bytes)
            if (_codeHasPush4(token, 0xe3ee160e) || _codeHasPush4(token, 0xcf092995) || _codeHasPush4(token, 0xef55bec6)) {
                flags |= EIP3009_SELECTOR_IN_CODE; // transferWithAuthorization (v,r,s / bytes), receiveWithAuthorization
            }
            if (_codeHasPush4(token, 0x8fcbaf0c)) flags |= DAI_PERMIT_SELECTOR_IN_CODE;
            if (_returnsAtLeast(token, abi.encodeWithSignature("DOMAIN_SEPARATOR()"), 32)) {
                flags |= DOMAIN_SEPARATOR_CALLABLE;
            }
            if (_returnsAtLeast(token, abi.encodeWithSignature("nonces(address)", account), 32)) {
                flags |= NONCES_CALLABLE;
            }
            if (_returnsAtLeast(token, abi.encodeWithSignature("eip712Domain()"), 224)) {
                flags |= EIP712_DOMAIN_CALLABLE;
            }
        }
        flags |= _pqcFlags(account);
    }

    function isExposed(uint16 flags) public pure returns (bool) {
        return flags & EXPOSURE_MASK != 0;
    }

    function count() external view returns (uint256) {
        return checks.length;
    }

    /// @notice The most recent checks, newest first.
    function latest(uint256 limit) external view returns (Check[] memory out) {
        uint256 n = checks.length < limit ? checks.length : limit;
        out = new Check[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = checks[checks.length - 1 - i];
        }
    }

    // ------------------------------------------------------------------ write

    /// @notice Scan `token` for the caller and record the result on chain.
    function record(address token) external returns (uint16 flags) {
        flags = scan(token, msg.sender);
        checks.push(Check(msg.sender, token, flags, uint64(block.timestamp)));
        checksBy[msg.sender] += 1;
        emit Checked(msg.sender, token, flags, isExposed(flags));
    }

    // ------------------------------------------------------------------ internals

    /// @dev Searches runtime code for PUSH4 <selector>, the way Solidity dispatchers embed selectors. Heuristic: it
    ///      can false-positive on matching bytes inside push data or metadata, and misses dispatchers that do not
    ///      use PUSH4 (e.g. some Vyper builds); DOMAIN_SEPARATOR() is the proxy-safe second signal.
    function _codeHasPush4(address target, bytes4 selector) private view returns (bool found) {
        uint256 needle = (uint256(0x63) << 32) | uint256(uint32(selector)); // 5 bytes: 0x63 ++ selector
        assembly {
            let size := extcodesize(target)
            let ptr := mload(0x40)
            extcodecopy(target, ptr, 0, size)
            mstore(0x40, add(ptr, add(size, 32))) // reserve; trailing word is zero padding
            let end := add(ptr, size)
            mstore(end, 0) // the 4 bytes read past the code are always zero
            for { let p := ptr } lt(p, end) { p := add(p, 1) } {
                if eq(shr(216, mload(p)), needle) {
                    found := 1
                    break
                }
            }
        }
    }

    function _returnsAtLeast(address target, bytes memory data, uint256 minLen) private view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall{gas: 100_000}(data);
        return ok && ret.length >= minLen;
    }

    /// @dev Reads pqcKeyStatus. On a network where the precompile is inactive this returns no flags.
    function _pqcFlags(address account) private view returns (uint16 flags) {
        (bool ok, bytes memory ret) = PQC_KEY_STATUS.staticcall(
            abi.encodeWithSignature("pqcKeyStatus(address)", account)
        );
        if (!ok || ret.length < 160) return 0;
        (bool registered, uint8 alg,, bool proven) = abi.decode(ret, (bool, uint8, bytes, bool));
        if (registered) flags |= PQC_KEY_REGISTERED;
        if (alg == 1) flags |= PQC_ALG_MLDSA87;
        if (proven) flags |= PQC_POSSESSION_PROVEN;
    }
}
