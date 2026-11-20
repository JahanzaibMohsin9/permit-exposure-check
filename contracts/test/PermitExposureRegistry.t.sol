// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PermitExposureRegistry} from "../src/PermitExposureRegistry.sol";

contract PlainToken is ERC20 {
    constructor() ERC20("Plain", "PLN") {}
}

contract PermitToken is ERC20Permit {
    constructor() ERC20("Permit", "PRM") ERC20Permit("Permit") {}
}

/// DAI-style permit(holder, spender, nonce, expiry, allowed, v, r, s).
contract DaiStyleToken {
    function permit(address, address, uint256, uint256, bool, uint8, bytes32, bytes32) external pure {}
}

/// USDC-style EIP-3009: a leaked ECDSA key can move funds with a signature alone.
contract Eip3009Token {
    function transferWithAuthorization(address, address, uint256, uint256, uint256, bytes32, uint8, bytes32, bytes32) external pure {}
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, uint8, bytes32, bytes32) external pure {}
}

/// permit(owner, spender, value, deadline, bytes signature): the bytes-signature permit variant.
contract BytesPermitToken {
    function permit(address, address, uint256, uint256, bytes calldata) external pure {}
}

contract PermitExposureRegistryTest is Test {
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    PermitExposureRegistry reg;
    address user = makeAddr("user");

    function setUp() public {
        reg = new PermitExposureRegistry();
    }

    function _has(uint16 flags, uint16 f) internal pure returns (bool) {
        return flags & f == f;
    }

    function test_eip2612TokenIsExposed() public {
        uint16 f = reg.scan(address(new PermitToken()), user);
        assertTrue(_has(f, reg.HAS_CODE()));
        assertTrue(_has(f, reg.EIP2612_SELECTOR_IN_CODE()));
        assertTrue(_has(f, reg.DOMAIN_SEPARATOR_CALLABLE()));
        assertTrue(_has(f, reg.NONCES_CALLABLE()));
        assertTrue(_has(f, reg.EIP712_DOMAIN_CALLABLE()));
        assertTrue(reg.isExposed(f));
    }

    function test_plainErc20IsNotExposed() public {
        uint16 f = reg.scan(address(new PlainToken()), user);
        assertEq(f, reg.HAS_CODE());
        assertFalse(reg.isExposed(f));
    }

    function test_permitTokenBehindProxyIsStillExposed() public {
        PermitToken impl = new PermitToken();
        address proxy = address(new ERC1967Proxy(address(impl), ""));
        uint16 f = reg.scan(proxy, user);
        assertFalse(_has(f, reg.EIP2612_SELECTOR_IN_CODE())); // not in the proxy's own code
        assertTrue(_has(f, reg.DOMAIN_SEPARATOR_CALLABLE())); // but reachable through it
        assertTrue(reg.isExposed(f));
    }

    function test_daiStylePermitIsExposed() public {
        uint16 f = reg.scan(address(new DaiStyleToken()), user);
        assertTrue(_has(f, reg.DAI_PERMIT_SELECTOR_IN_CODE()));
        assertTrue(reg.isExposed(f));
    }

    /// Review finding PEC-1: USDC-style EIP-3009 tokens are exposed and must not read "not exposed".
    function test_eip3009TokenIsExposed() public {
        uint16 f = reg.scan(address(new Eip3009Token()), user);
        assertTrue(_has(f, reg.EIP3009_SELECTOR_IN_CODE()));
        assertTrue(reg.isExposed(f));
    }

    function test_bytesSignaturePermitIsExposed() public {
        uint16 f = reg.scan(address(new BytesPermitToken()), user);
        assertTrue(_has(f, reg.EIP2612_SELECTOR_IN_CODE()));
        assertTrue(reg.isExposed(f));
    }

    function test_tokenAndAccountMasksSplitTheFlags() public view {
        assertEq(reg.TOKEN_MASK() & reg.ACCOUNT_MASK(), 0);
        assertEq(reg.TOKEN_MASK() | reg.ACCOUNT_MASK(), 0x03FF);
    }

    function test_addressWithoutCode() public {
        assertEq(reg.scan(makeAddr("eoa"), user), 0);
    }

    function test_pqcStatusRegisteredAndProven() public {
        vm.etch(PQC_KEY_STATUS, hex"00"); // make the address "exist" so mockCall applies
        vm.mockCall(
            PQC_KEY_STATUS,
            abi.encodeWithSignature("pqcKeyStatus(address)", user),
            abi.encode(true, uint8(1), new bytes(2592), true)
        );
        uint16 f = reg.scan(address(new PlainToken()), user);
        assertTrue(_has(f, reg.PQC_KEY_REGISTERED()));
        assertTrue(_has(f, reg.PQC_ALG_MLDSA87()));
        assertTrue(_has(f, reg.PQC_POSSESSION_PROVEN()));
    }

    function test_pqcRegisteredWithoutPossessionProof() public {
        vm.etch(PQC_KEY_STATUS, hex"00");
        vm.mockCall(
            PQC_KEY_STATUS,
            abi.encodeWithSignature("pqcKeyStatus(address)", user),
            abi.encode(true, uint8(1), new bytes(2592), false)
        );
        uint16 f = reg.scan(address(0), user);
        assertTrue(_has(f, reg.PQC_KEY_REGISTERED()));
        assertFalse(_has(f, reg.PQC_POSSESSION_PROVEN()));
    }

    function test_inactivePrecompileGivesNoPqcFlagsAndDoesNotRevert() public view {
        assertEq(reg.scan(address(0), user), 0);
    }

    function test_recordStoresAndListsNewestFirst() public {
        address a = address(new PermitToken());
        address b = address(new PlainToken());
        vm.prank(user);
        uint16 fa = reg.record(a);
        vm.prank(user);
        reg.record(b);

        assertEq(reg.count(), 2);
        assertEq(reg.checksBy(user), 2);
        PermitExposureRegistry.Check[] memory l = reg.latest(10);
        assertEq(l.length, 2);
        assertEq(l[0].token, b);
        assertEq(l[1].token, a);
        assertEq(l[1].flags, fa);
        assertEq(l[1].account, user);
        assertEq(reg.latest(1).length, 1);
    }

    function test_recordEmitsEvent() public {
        address t = address(new PermitToken());
        uint16 expected = reg.scan(t, user);
        vm.expectEmit(true, true, false, true);
        emit PermitExposureRegistry.Checked(user, t, expected, true);
        vm.prank(user);
        reg.record(t);
    }

    function test_scanGasIsReasonable() public {
        address t = address(new PermitToken());
        uint256 g = gasleft();
        reg.scan(t, user);
        assertLt(g - gasleft(), 3_000_000);
    }
}
