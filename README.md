# Permit Exposure Check

[![Built on QoreChain](https://build.qorechain.io/badge/permit-exposure-check.svg)](https://build.qorechain.io/p/permit-exposure-check)

> Build Before Q-Day · Quantum Pass
>
> **Demo video (1:59):** https://youtu.be/675KeQN44kE

**QoreChain's EVM windows protect transactions, not signatures.**
A leaked secp256k1 key can't send an EVM transaction on QoreChain, because that needs the owner's ML-DSA-87 key and an open window. But many ERC-20s accept **ECDSA-signed approvals or transfers**: EIP-2612 `permit`, DAI-style `permit`, and USDC-style EIP-3009 `transferWithAuthorization`. Anyone can relay these, so a leaked key can still move funds without the owner sending a transaction.

Permit Exposure Check answers two questions, then records the answer with a post-quantum signature:
1. **Is this token exposed?** The on-chain registry (`PermitExposureRegistry.scan`) and the browser both check:
   - permit selectors in the token's code (EIP-2612 `v,r,s` and `bytes` variants, DAI-style);
   - EIP-3009 authorization selectors;
   - whether `DOMAIN_SEPARATOR()` answers, which also catches permit tokens behind a proxy;
   - `nonces(address)` and `eip712Domain()`.
2. **Is my account ready?** It reads `pqcKeyStatus` (`0x…0a02`) for the account connected in QoreX: ML-DSA-87 key registered? Possession proven?
3. **Record:** QoreX **hybrid-signs (secp256k1 + ML-DSA-87)** one native transaction with the verdict in its memo. Recorded checks are listed in the app and **rechecked on chain**, since memos are self-reported.

| Folder | What |
|---|---|
| `web/` | Vite + React + wagmi, scaffolded with `npx create-qorechain-dapp --template viem-wagmi`. QoreX native connect and `signAndBroadcast`. See [web/README.md](web/README.md). |
| `contracts/` | Foundry: `PermitExposureRegistry.sol` (on-chain scanner and optional EVM recording), `DemoPermitToken.sol` (an exposed example), tests, deploy script. |

## Flags
`scan(token, account)` returns a `uint16`. **Token bits** (`TOKEN_MASK = 0x023F`) describe the token. **Account bits** (`ACCOUNT_MASK = 0x01C0`) describe the account's post-quantum key.

| Bit | Value | Meaning | Exposure? |
|---|---|---|---|
| 0 | 1 | token has code | |
| 1 | 2 | EIP-2612 `permit` selector (`v,r,s` or `bytes`) in code | **exposed** |
| 2 | 4 | DAI-style `permit` selector in code | **exposed** |
| 3 | 8 | `DOMAIN_SEPARATOR()` answers (also through proxies) | **exposed** |
| 4 | 16 | `nonces(address)` answers | |
| 5 | 32 | `eip712Domain()` answers (ERC-5267) | |
| 6 | 64 | *account:* ML-DSA-87 key registered | |
| 7 | 128 | *account:* algorithm is ML-DSA-87 | |
| 8 | 256 | *account:* possession proven | |
| 9 | 512 | EIP-3009 `transferWithAuthorization` / `receiveWithAuthorization` in code | **exposed** |

Live examples, scanned for a registered account:
- **fUSD** gives `449` = token bits `1` (has code, nothing exposed) + account bits `448` (registered, ML-DSA-87, proven).
- The **demo EIP-2612 token** gives `507` = token bits `59` (permit, DOMAIN_SEPARATOR, nonces, eip712Domain) + account bits `448`.

## Live on testnet (qorechain-diana)
| Contract / account | Address |
|---|---|
| PermitExposureRegistry (v2, with EIP-3009 detection) | `0xeAFB19853fd1bD966aB43e54777331FD03D7fd49` |
| DemoPermitToken (exposed example) | `0x47bad2BD1B77d02a88B2751D6629cAaD55C0eF72` |
| Journal account (receives the 1 uqor records) | `qor1ps3f779d94jvu6um0f9pdx465lfp24dkygpd8r` |

**Proof of a user's hybrid-signed record:**
- Transaction [`D06E179BD5AAD18A4B3FC3A73DD81C7E4D29379509F865EB81FE18C5457CAE30`](https://explore.qore.network/tx/D06E179BD5AAD18A4B3FC3A73DD81C7E4D29379509F865EB81FE18C5457CAE30) (block 10454464). The explorer opens on mainnet: click **Testnet** in its top bar first.
- Approved in QoreX by `qor177jch6w6r59zqph9spz7g5vajeqy5cfqpmpvkq`.
- It carries a `/qorechain.pqc.v1.PQCHybridSignature` extension with a 4,627-byte ML-DSA-87 signature, alongside the secp256k1 signature.
- Memo: `permit-check v1 token=0x97143b…63ca flags=449 exposed=false`.

## Tests
- `forge test` (14 tests):
  - EIP-2612, the bytes-signature permit, DAI-style permit and EIP-3009 tokens;
  - a permit token behind a proxy, a plain ERC-20, an address with no code;
  - PQ key states, an inactive precompile;
  - recording, events, and the flag masks.
- `forge test --match-path test/fork/LiveScan.t.sol --fork-url https://evm-testnet.qore.host`: live fUSD is not exposed and the live demo token is exposed. Without `--fork-url` it is reported as skipped. CI runs it as a required step.

## Run
```sh
cd contracts && forge test
cd web && npm install && npm run dev   # http://localhost:5173
```

## Limits (heuristics, stated honestly)
- The byte scan looks for `PUSH4 <selector>`. Matching bytes inside push data or metadata can give a false positive, and dispatchers that don't use `PUSH4` (some Vyper builds) can be missed. `DOMAIN_SEPARATOR()` is the proxy-safe second signal. `DOMAIN_SEPARATOR` alone also flags tokens that only have `delegateBySig`, which is still an ECDSA-signature path.
- Not covered: allowances granted to Permit2-style contracts, and ERC-2771 trusted forwarders.
- A token can behave differently when the scanner calls it. Treat "not exposed" as "no known ECDSA approval path found".

## Credits
- Scaffolded with `create-qorechain-dapp` (viem-wagmi template).
- Uses `@qorechain/evm` and `@qorechain/qorex-rainbowkit`.
- OpenZeppelin Contracts v5.4.0 and forge-std.

MIT licence.
