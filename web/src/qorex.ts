import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx.js";
import { bytesToHex, hexToBytes, type Address } from "viem";
import { bech32Decode, bech32Encode } from "./bech32.js";

/** QoreX native-lane provider (window.qorex.native), per docs.qorechain.io/qorex/browser-extension. */
export interface QorexNative {
  capabilities?: string[];
  enable(chainId: string): Promise<void>;
  getKey(chainId: string): Promise<{ bech32Address: string; name?: string }>;
  signAndBroadcast(req: {
    chainId: string;
    messages: { typeUrl: string; value: Uint8Array | number[] | string }[];
    memo?: string;
    gasLimit?: number;
  }): Promise<{ txHash: string; code: number; height?: number }>;
}

declare global {
  interface Window {
    qorex?: { native?: QorexNative };
  }
}

export const CHAIN_ID = "qorechain-diana";
export const MEMO_PREFIX = "permit-check v1";

export const qorexNative = (): QorexNative | undefined => window.qorex?.native;

export const qorToEvm = (bech32: string): Address => bytesToHex(bech32Decode(bech32).data) as Address;
export const evmToQor = (addr: string): string => bech32Encode("qor", hexToBytes(addr as Address));

export async function connectQorex(): Promise<{ qor: string; evm: Address; name?: string }> {
  const q = qorexNative();
  if (!q) throw new Error("QoreX not found. Install it, switch it to Testnet, then reload this page.");
  await q.enable(CHAIN_ID);
  const key = await q.getKey(CHAIN_ID);
  return { qor: key.bech32Address, evm: qorToEvm(key.bech32Address), name: key.name };
}

/**
 * Record a check with ONE hybrid-signed (secp256k1 + ML-DSA-87) native transaction, built and signed by QoreX:
 * a 1 uqor transfer to the journal (the registry contract's account) with the verdict in the memo.
 */
export async function recordWithQorex(p: { from: string; journal: string; token: Address; flags: number; exposed: boolean }) {
  const q = qorexNative();
  if (!q) throw new Error("QoreX not found.");
  if (!q.capabilities?.includes("signAndBroadcast")) throw new Error("This QoreX build has no signAndBroadcast. Please update QoreX.");
  const value = MsgSend.encode(
    MsgSend.fromPartial({ fromAddress: p.from, toAddress: p.journal, amount: [{ denom: "uqor", amount: "1" }] }),
  ).finish();
  return q.signAndBroadcast({
    chainId: CHAIN_ID,
    messages: [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value }],
    memo: `${MEMO_PREFIX} token=${p.token.toLowerCase()} flags=${p.flags} exposed=${p.exposed}`,
    gasLimit: 400_000,
  });
}

export interface JournalEntry {
  txHash: string;
  from: string;
  token: string;
  flags: number;
  exposed: boolean;
  time: string;
}

/** Read recorded checks back from chain (REST tx search through the dev-server proxy). */
export async function readJournal(rest: string, journal: string, limit = 10): Promise<JournalEntry[]> {
  const query = encodeURIComponent(`transfer.recipient='${journal}'`);
  const res = await fetch(`${rest}/cosmos/tx/v1beta1/txs?query=${query}&order_by=ORDER_BY_DESC&limit=${limit * 3}`);
  if (!res.ok) throw new Error(`tx search failed: HTTP ${res.status}`);
  const body = (await res.json()) as { tx_responses?: any[] };
  const out: JournalEntry[] = [];
  for (const r of body.tx_responses ?? []) {
    const memo: string = r.tx?.body?.memo ?? "";
    if (r.code !== 0 || !memo.startsWith(MEMO_PREFIX)) continue;
    const m = /token=(0x[0-9a-f]{40}) flags=(\d+) exposed=(true|false)/.exec(memo);
    if (!m) continue;
    out.push({
      txHash: r.txhash,
      from: r.tx?.body?.messages?.[0]?.from_address ?? "",
      token: m[1],
      flags: Number(m[2]),
      exposed: m[3] === "true",
      time: r.timestamp,
    });
    if (out.length >= limit) break;
  }
  return out;
}
