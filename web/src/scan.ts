import { getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";

/** Same flag layout as PermitExposureRegistry.sol. */
export const FLAGS = {
  HAS_CODE: 1 << 0,
  EIP2612_SELECTOR_IN_CODE: 1 << 1,
  DAI_PERMIT_SELECTOR_IN_CODE: 1 << 2,
  DOMAIN_SEPARATOR_CALLABLE: 1 << 3,
  NONCES_CALLABLE: 1 << 4,
  EIP712_DOMAIN_CALLABLE: 1 << 5,
  PQC_KEY_REGISTERED: 1 << 6,
  PQC_ALG_MLDSA87: 1 << 7,
  PQC_POSSESSION_PROVEN: 1 << 8,
  EIP3009_SELECTOR_IN_CODE: 1 << 9,
  // Browser-only bits (the on-chain registry cannot read another contract's storage, so it can't follow proxies):
  PROXY_DETECTED: 1 << 10,
  IMPL_SIGNATURE_PATH: 1 << 11, // permit / EIP-3009 selector found in the proxy's IMPLEMENTATION code
} as const;

export const TOKEN_MASK = 0x023f;
/** Bits the on-chain registry also computes; the browser and the registry are compared on these. */
export const REGISTRY_BITS = 0x03ff;
export const BROWSER_ONLY = FLAGS.PROXY_DETECTED | FLAGS.IMPL_SIGNATURE_PATH;

export const EXPOSURE_MASK =
  FLAGS.EIP2612_SELECTOR_IN_CODE |
  FLAGS.DAI_PERMIT_SELECTOR_IN_CODE |
  FLAGS.DOMAIN_SEPARATOR_CALLABLE |
  FLAGS.EIP3009_SELECTOR_IN_CODE |
  FLAGS.IMPL_SIGNATURE_PATH;

/** PUSH4 <selector> at a byte-aligned position of the runtime code (hex string without 0x). */
const hasPush4 = (hex: string, selector: string) => {
  const needle = `63${selector}`;
  for (let i = hex.indexOf(needle); i !== -1; i = hex.indexOf(needle, i + 1)) if (i % 2 === 0) return true;
  return false;
};

export const has = (flags: number, f: number) => (flags & f) === f;
export const isExposed = (flags: number) => (flags & EXPOSURE_MASK) !== 0;
/**
 * No permit found, but the token answers nonces(address) or eip712Domain(), which usually accompany signed
 * approvals (e.g. a permit reached through a proxy or a fallback the byte scan can't see). Treated as a warning.
 */
export const isPossiblyExposed = (flags: number) =>
  !isExposed(flags) && (flags & (FLAGS.NONCES_CALLABLE | FLAGS.EIP712_DOMAIN_CALLABLE)) !== 0;

const SIGNATURE_SELECTORS = ["d505accf", "9fd5a6cf", "8fcbaf0c", "e3ee160e", "cf092995", "ef55bec6"];
const hasSignatureSelector = (hex: string) => SIGNATURE_SELECTORS.some((sel) => hasPush4(hex, sel));

// Proxy patterns: EIP-1967 implementation and beacon slots, the legacy OpenZeppelin slot, EIP-1822 (UUPS),
// and EIP-1167 minimal proxies (implementation address embedded in the bytecode).
const SLOT_IMPL_1967: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_BEACON_1967: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const SLOT_IMPL_OZ_LEGACY: Hex = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const SLOT_IMPL_1822: Hex = "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7";
const beaconAbi = parseAbi(["function implementation() view returns (address)"]);

const slotAddress = (word: Hex | undefined): Address | undefined => {
  if (!word || BigInt(word) === 0n) return undefined;
  return getAddress(`0x${word.slice(-40)}`);
};

/** The implementation behind `token` if it is a recognised proxy, else undefined. */
export async function resolveImplementation(client: PublicClient, token: Address, codeHex: string): Promise<Address | undefined> {
  const minimal = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/.exec(codeHex);
  if (minimal) return getAddress(`0x${minimal[1]}`);
  for (const slot of [SLOT_IMPL_1967, SLOT_IMPL_OZ_LEGACY, SLOT_IMPL_1822]) {
    const impl = slotAddress(await client.getStorageAt({ address: token, slot }).catch(() => undefined));
    if (impl) return impl;
  }
  const beacon = slotAddress(await client.getStorageAt({ address: token, slot: SLOT_BEACON_1967 }).catch(() => undefined));
  if (beacon) {
    return await client.readContract({ address: beacon, abi: beaconAbi, functionName: "implementation" }).catch(() => undefined);
  }
  return undefined;
}

export const registryAbi = parseAbi([
  "function scan(address token, address account) view returns (uint16)",
  "function record(address token) returns (uint16)",
  "function count() view returns (uint256)",
  "function latest(uint256 limit) view returns ((address account, address token, uint16 flags, uint64 timestamp)[])",
  "event Checked(address indexed account, address indexed token, uint16 flags, bool exposed)",
]);

const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as const;
const pqcAbi = parseAbi(["function pqcKeyStatus(address) view returns (bool, uint8, bytes, bool)"]);
const probeAbi = parseAbi([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function nonces(address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
]);

const ok = async (p: Promise<unknown>) => p.then(() => true, () => false);

/**
 * Client-side mirror of PermitExposureRegistry.scan, used before the registry is deployed
 * and as a cross-check of the on-chain result.
 */
export async function scanInBrowser(client: PublicClient, token: Address, account: Address): Promise<number> {
  return (await scanDetailed(client, token, account)).flags;
}

/** As scanInBrowser, plus the implementation address when the token is a proxy. */
export async function scanDetailed(client: PublicClient, token: Address, account: Address): Promise<{ flags: number; implementation?: Address }> {
  let flags = 0;
  let implementation: Address | undefined;
  const code = (await client.getCode({ address: token })) ?? "0x";
  if (code !== "0x") {
    flags |= FLAGS.HAS_CODE;
    const hex = code.toLowerCase().slice(2);
    if (hasPush4(hex, "d505accf") || hasPush4(hex, "9fd5a6cf")) flags |= FLAGS.EIP2612_SELECTOR_IN_CODE;
    if (hasPush4(hex, "8fcbaf0c")) flags |= FLAGS.DAI_PERMIT_SELECTOR_IN_CODE;
    if (hasPush4(hex, "e3ee160e") || hasPush4(hex, "cf092995") || hasPush4(hex, "ef55bec6")) flags |= FLAGS.EIP3009_SELECTOR_IN_CODE;
    const [ds, nn, ed] = await Promise.all([
      ok(client.readContract({ address: token, abi: probeAbi, functionName: "DOMAIN_SEPARATOR" })),
      ok(client.readContract({ address: token, abi: probeAbi, functionName: "nonces", args: [account] })),
      ok(client.readContract({ address: token, abi: probeAbi, functionName: "eip712Domain" })),
    ]);
    if (ds) flags |= FLAGS.DOMAIN_SEPARATOR_CALLABLE;
    if (nn) flags |= FLAGS.NONCES_CALLABLE;
    if (ed) flags |= FLAGS.EIP712_DOMAIN_CALLABLE;
    implementation = await resolveImplementation(client, token, hex);
    if (implementation) {
      flags |= FLAGS.PROXY_DETECTED;
      const implCode = ((await client.getCode({ address: implementation })) ?? "0x").toLowerCase().slice(2);
      if (hasSignatureSelector(implCode)) flags |= FLAGS.IMPL_SIGNATURE_PATH;
    }
  }
  flags |= await pqcFlags(client, account);
  return { flags, implementation };
}

async function pqcFlags(client: PublicClient, account: Address): Promise<number> {
  try {
    const [registered, alg, , proven] = await client.readContract({
      address: PQC_KEY_STATUS,
      abi: pqcAbi,
      functionName: "pqcKeyStatus",
      args: [account],
    });
    return (
      (registered ? FLAGS.PQC_KEY_REGISTERED : 0) |
      (alg === 1 ? FLAGS.PQC_ALG_MLDSA87 : 0) |
      (proven ? FLAGS.PQC_POSSESSION_PROVEN : 0)
    );
  } catch {
    return 0; // precompile inactive on this network
  }
}
