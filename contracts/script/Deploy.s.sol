// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PermitExposureRegistry} from "../src/PermitExposureRegistry.sol";
import {DemoPermitToken} from "../src/DemoPermitToken.sol";

/// Deploy to qorechain-diana. The deployer needs a registered ML-DSA-87 key and a live EVM window.
///   forge script script/Deploy.s.sol --rpc-url https://evm-testnet.qore.host --broadcast --private-key $PK
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        PermitExposureRegistry registry = new PermitExposureRegistry();
        DemoPermitToken demo = new DemoPermitToken(msg.sender);
        vm.stopBroadcast();
        console.log("VITE_REGISTRY_ADDRESS=%s", address(registry));
        console.log("VITE_DEMO_PERMIT_TOKEN=%s", address(demo));
    }
}
