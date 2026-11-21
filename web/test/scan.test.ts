// Offline tests for the browser scanner (mock chain client):  npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { FLAGS, has, isExposed, isPossiblyExposed, resolveImplementation, scanDetailed } from "../src/scan.ts";

const TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const IMPL = "0x00000000000000000000000000000000000000bb" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000cc" as Address;
const SLOT_1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** Runtime code that dispatches the given selectors with PUSH4 (enough for the byte scan). */
const codeWith = (...selectors: string[]) => `0x6080${selectors.map((s) => `63${s}`).join("")}00` as Hex;

function mockClient(o: {
  code: Record<string, Hex>;
  storage?: Record<string, Hex>; // `${address}:${slot}` -> word
  answers?: string[]; // view functions the token answers
}): PublicClient {
  return {
    getCode: async ({ address }: { address: Address }) => o.code[address.toLowerCase()] ?? "0x",
    getStorageAt: async ({ address, slot }: { address: Address; slot: Hex }) =>
      o.storage?.[`${address.toLowerCase()}:${slot}`] ?? `0x${"0".repeat(64)}`,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "pqcKeyStatus") throw new Error("inactive");
      if (o.answers?.includes(functionName)) return 1n;
      throw new Error("execution reverted");
    },
  } as unknown as PublicClient;
}

test("proxy slot constants are the standard ones", () => {
  const minusOne = (s: string) => toHex(BigInt(keccak256(toHex(s))) - 1n, { size: 32 });
  assert.equal(minusOne("eip1967.proxy.implementation"), SLOT_1967);
  assert.equal(minusOne("eip1967.proxy.beacon"), "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50");
  assert.equal(keccak256(toHex("PROXIABLE")), "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7");
  assert.equal(keccak256(toHex("org.zeppelinos.proxy.implementation")), "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3");
});

test("review M-1: a COMP-style permit token behind an ERC-1967 proxy is reported exposed", async () => {
  // The proxy's own code has no permit selector and the token has no DOMAIN_SEPARATOR(): the registry misses it.
  const client = mockClient({
    code: { [TOKEN]: codeWith(), [IMPL]: codeWith("d505accf") },
    storage: { [`${TOKEN}:${SLOT_1967}`]: `0x${"0".repeat(24)}${IMPL.slice(2)}` as Hex },
    answers: ["nonces"],
  });
  const r = await scanDetailed(client, TOKEN, ACCOUNT);
  assert.equal(r.implementation?.toLowerCase(), IMPL);
  assert.ok(has(r.flags, FLAGS.PROXY_DETECTED));
  assert.ok(has(r.flags, FLAGS.IMPL_SIGNATURE_PATH));
  assert.ok(isExposed(r.flags));
});

test("an EIP-1167 minimal proxy is followed to its implementation", async () => {
  const minimal = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
  const client = mockClient({ code: { [TOKEN]: minimal, [IMPL]: codeWith("e3ee160e") } });
  assert.equal((await resolveImplementation(client, TOKEN, minimal.slice(2)))?.toLowerCase(), IMPL);
  assert.ok(isExposed((await scanDetailed(client, TOKEN, ACCOUNT)).flags));
});

test("a proxy whose implementation has no signature path is not exposed", async () => {
  const client = mockClient({
    code: { [TOKEN]: codeWith(), [IMPL]: codeWith("a9059cbb") }, // transfer only
    storage: { [`${TOKEN}:${SLOT_1967}`]: `0x${"0".repeat(24)}${IMPL.slice(2)}` as Hex },
  });
  const r = await scanDetailed(client, TOKEN, ACCOUNT);
  assert.ok(has(r.flags, FLAGS.PROXY_DETECTED));
  assert.equal(isExposed(r.flags), false);
});

test("no permit selector but nonces() answers: 'possibly exposed', not 'safe'", async () => {
  const client = mockClient({ code: { [TOKEN]: codeWith("a9059cbb") }, answers: ["nonces"] });
  const r = await scanDetailed(client, TOKEN, ACCOUNT);
  assert.equal(isExposed(r.flags), false);
  assert.equal(isPossiblyExposed(r.flags), true);
});

test("a plain ERC-20 has no approval path", async () => {
  const client = mockClient({ code: { [TOKEN]: codeWith("a9059cbb", "095ea7b3") } });
  const r = await scanDetailed(client, TOKEN, ACCOUNT);
  assert.equal(isExposed(r.flags), false);
  assert.equal(isPossiblyExposed(r.flags), false);
  assert.equal(r.implementation, undefined);
});

test("direct permit, DAI-style permit and EIP-3009 selectors are each exposures", async () => {
  for (const sel of ["d505accf", "9fd5a6cf", "8fcbaf0c", "e3ee160e", "cf092995", "ef55bec6"]) {
    const r = await scanDetailed(mockClient({ code: { [TOKEN]: codeWith(sel) } }), TOKEN, ACCOUNT);
    assert.ok(isExposed(r.flags), sel);
  }
});
