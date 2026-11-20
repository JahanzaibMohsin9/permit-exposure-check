import { parseAbi, type Address, type PublicClient } from "viem";

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
} as const;

export const EXPOSURE_MASK =
  FLAGS.EIP2612_SELECTOR_IN_CODE | FLAGS.DAI_PERMIT_SELECTOR_IN_CODE | FLAGS.DOMAIN_SEPARATOR_CALLABLE;

export const has = (flags: number, f: number) => (flags & f) === f;
export const isExposed = (flags: number) => (flags & EXPOSURE_MASK) !== 0;

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
  let flags = 0;
  const code = (await client.getCode({ address: token })) ?? "0x";
  if (code !== "0x") {
    flags |= FLAGS.HAS_CODE;
    const hex = code.toLowerCase();
    if (hex.includes("63d505accf")) flags |= FLAGS.EIP2612_SELECTOR_IN_CODE;
    if (hex.includes("638fcbaf0c")) flags |= FLAGS.DAI_PERMIT_SELECTOR_IN_CODE;
    const [ds, nn, ed] = await Promise.all([
      ok(client.readContract({ address: token, abi: probeAbi, functionName: "DOMAIN_SEPARATOR" })),
      ok(client.readContract({ address: token, abi: probeAbi, functionName: "nonces", args: [account] })),
      ok(client.readContract({ address: token, abi: probeAbi, functionName: "eip712Domain" })),
    ]);
    if (ds) flags |= FLAGS.DOMAIN_SEPARATOR_CALLABLE;
    if (nn) flags |= FLAGS.NONCES_CALLABLE;
    if (ed) flags |= FLAGS.EIP712_DOMAIN_CALLABLE;
  }
  flags |= await pqcFlags(client, account);
  return flags;
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
