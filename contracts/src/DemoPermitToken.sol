// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice DEMO ONLY: a standard OpenZeppelin EIP-2612 token, deployed so the checker has a live "exposed" example.
contract DemoPermitToken is ERC20Permit {
    constructor(address holder) ERC20("Demo Permit USD", "dpUSD") ERC20Permit("Demo Permit USD") {
        _mint(holder, 1_000_000e18);
    }
}
