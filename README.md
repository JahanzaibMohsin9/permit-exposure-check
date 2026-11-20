# Permit Exposure Check

> Build Before Q-Day · Quantum Pass

**QoreChain's EVM windows protect transactions, not signatures.**
A leaked secp256k1 key can't send an EVM transaction on QoreChain, because that needs the owner's ML-DSA-87 key and an open window. But many ERC-20s accept an **ECDSA-signed `permit`** (EIP-2612 or DAI-style). Anyone can relay a permit, so a leaked key can still approve spending, and the owner never sends a transaction.

Permit Exposure Check answers two questions:
1. **Is this token exposed?** It looks for permit selectors in the token's code, `DOMAIN_SEPARATOR()` (which also catches tokens behind proxies), `nonces(address)` and `eip712Domain()`.
2. **Is my account ready?** It reads `pqcKeyStatus` (`0x…0a02`) to show whether an ML-DSA-87 key is registered and whether possession is proven, plus the EVM window status.

Then it **records the check on chain** with one QoreX-approved transaction.

| Folder | What it contains |
|---|---|
| `web/` | Vite + React + wagmi + RainbowKit with the QoreX wallet, scaffolded with `npx create-qorechain-dapp --template viem-wagmi`. |
| `contracts/` | Foundry: `PermitExposureRegistry.sol` (on-chain scan and records), `DemoPermitToken.sol` (an exposed example), tests and a deploy script. |

## Results so far
- `forge test` passes **11/11**: EIP-2612, DAI-style, permit behind a proxy, plain ERC-20, no code, PQ key states, inactive precompile, recording and events.
- Live testnet fUSD (`0x97143B…63CA`) gives **flags 1, not exposed**. The on-chain scan (fork test) and the in-browser scan agree.

## Run
```sh
cd contracts && forge test
cd web && npm install && npm run dev   # http://localhost:5173
```

## Deploy (testnet)
```sh
cd contracts
forge script script/Deploy.s.sol --rpc-url https://evm-testnet.qore.host --broadcast --private-key $PK
# put the printed addresses into web/.env (see web/.env.example)
```
The deployer needs a registered ML-DSA-87 key and a live EVM window.

## Credits
- Scaffolded with `create-qorechain-dapp` (viem-wagmi template).
- Uses `@qorechain/evm` and `@qorechain/qorex-rainbowkit`.
- OpenZeppelin Contracts v5.4.0.
- forge-std.

## License
MIT

## Live on testnet (qorechain-diana)
| Contract | Address |
|---|---|
| PermitExposureRegistry | `0x0C229f78AD2d64CE6b9b7A4a169abaa7D21555b6` |
| DemoPermitToken (exposed example) | `0x47bad2BD1B77d02a88B2751D6629cAaD55C0eF72` |

Live scans with the registry: fUSD gives flags **449** (not exposed). The demo EIP-2612 token gives flags **507** (exposed). A registered account shows its ML-DSA-87 key flags straight from the real `pqcKeyStatus` precompile.

## How recording works
- **QoreX (default):** the app calls `window.qorex.native.signAndBroadcast`. QoreX builds and **hybrid-signs (secp256k1 + ML-DSA-87)** one native transaction: 1 uqor to the registry's account `qor1ps3f779d94jvu6um0f9pdx465lfp24dkygpd8r`, with the memo `permit-check v1 token=… flags=… exposed=…`. The app reads the records back with a REST tx search.
- **EVM wallet (advanced):** `PermitExposureRegistry.record(token)` scans on chain and stores the result. This needs an EVM wallet such as MetaMask with an open EVM window. QoreX's EVM provider cannot send transactions yet.
- Your account is read from the QoreX **native** key, so the post-quantum status shown is the status of the account that holds the registered ML-DSA-87 key.

## Proof: a user's hybrid-signed record (QoreX)
Transaction `D06E179BD5AAD18A4B3FC3A73DD81C7E4D29379509F865EB81FE18C5457CAE30` (block 10454464) was approved in QoreX by `qor177jch6w6r59zqph9spz7g5vajeqy5cfqpmpvkq`. It carries a `/qorechain.pqc.v1.PQCHybridSignature` extension with an ML-DSA-87 signature (about 4.6 KB) alongside the secp256k1 signature. Memo: `permit-check v1 token=0x97143b…63ca flags=449 exposed=false`.
