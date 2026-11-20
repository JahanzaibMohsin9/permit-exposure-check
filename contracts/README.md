# Contracts

- `src/PermitExposureRegistry.sol`: an on-chain scanner for ECDSA `permit` exposure, plus the post-quantum status of an account (`pqcKeyStatus`). It can also record checks.
- `src/DemoPermitToken.sol`: a standard EIP-2612 token, deployed as a live "exposed" example.
- `test/`: unit tests, plus `test/fork/LiveScan.t.sol` (a read-only scan against the live testnet).

```sh
forge test
forge test --match-path test/fork/LiveScan.t.sol --fork-url https://evm-testnet.qore.host -vv
```
