# Permit Exposure Check: web app

Vite + React + wagmi, scaffolded with `npx create-qorechain-dapp --template viem-wagmi` (QoreChain's official starter), then built into the Permit Exposure Check UI.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check and production build
```

## What it does
1. **Token:** scans a token in the browser and on chain through `PermitExposureRegistry.scan` (both must agree), then explains every signal:
   - EIP-2612 / DAI-style / bytes-signature `permit`;
   - EIP-3009 authorizations;
   - `DOMAIN_SEPARATOR()`, which also catches permit tokens behind a proxy;
   - `nonces` and `eip712Domain`.
2. **Your account:** connects **QoreX through its native provider** (`window.qorex.native`) and reads the account's ML-DSA-87 status from the `pqcKeyStatus` precompile.
3. **Record:** QoreX hybrid-signs (secp256k1 + ML-DSA-87) one native transaction: 1 uqor to the journal account, with the verdict in the memo.
   - Recorded checks are read back with a REST tx search.
   - Each is **re-verified**: the token is rescanned on chain and compared with the memo, since memos are self-reported.

## Configuration (`.env`, all optional)
| Variable | Default |
|---|---|
| `VITE_REGISTRY_ADDRESS` | the deployed registry on qorechain-diana |
| `VITE_DEMO_PERMIT_TOKEN` | the deployed demo EIP-2612 token |
| `VITE_JOURNAL` | `qor1ps3f779d94jvu6um0f9pdx465lfp24dkygpd8r` (fixed journal account) |

The public REST endpoint sends no CORS headers, so the dev and preview servers proxy `/lcd-testnet` to `https://api-testnet.qore.host` (`vite.config.ts`). A production host needs the same proxy.

Why not QoreX's EVM provider? It answers account and network queries only; it cannot sign EVM transactions yet (QoreX docs). It also exposes an Ethereum-style account, not the user's registered native one. The advanced "record through the EVM registry" path is kept for MetaMask users with an open EVM window.
