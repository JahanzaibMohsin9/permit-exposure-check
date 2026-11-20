// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {PermitExposureRegistry} from "../../src/PermitExposureRegistry.sol";

/// Run: forge test --match-path test/fork/LiveScan.t.sol --fork-url https://evm-testnet.qore.host -vv
/// Note: QoreChain's PQC precompiles do not exist in a local fork, so PQC flags read 0 here.
contract LiveScanTest is Test {
    function test_scanLiveTokens() public {
        if (block.chainid != 9800) return; // only meaningful on a qorechain-diana fork
        PermitExposureRegistry reg = new PermitExposureRegistry();
        address fUSD = 0x97143B771D34ddb9130b807b135Ae675A5a963CA;
        uint16 f = reg.scan(fUSD, address(this));
        console.log("fUSD flags:", f, "exposed:", reg.isExposed(f));
        assertFalse(reg.isExposed(f));
    }
}
