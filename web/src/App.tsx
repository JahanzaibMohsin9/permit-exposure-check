import { ConnectButton } from "@rainbow-me/rainbowkit";
import { classifyEvmWindowRejection, evmWindowStatus, qorechainTestnet, type EvmWindowRejection } from "@qorechain/evm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { isAddress, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { connectQorex, evmToQor, qorexNative, readJournal, recordWithQorex } from "./qorex.js";
import { FLAGS, has, isExposed, registryAbi, scanInBrowser } from "./scan.js";

// Defaults: the instances deployed on qorechain-diana (override in .env).
const REGISTRY = (import.meta.env.VITE_REGISTRY_ADDRESS || "0x0C229f78AD2d64CE6b9b7A4a169abaa7D21555b6") as Address | undefined;
const DEMO_PERMIT_TOKEN = (import.meta.env.VITE_DEMO_PERMIT_TOKEN || "0x47bad2BD1B77d02a88B2751D6629cAaD55C0eF72") as Address | undefined;
const JOURNAL = REGISTRY ? evmToQor(REGISTRY) : undefined; // the registry contract's native account receives the records
const REST = "/lcd-testnet"; // Vite proxy to https://api-testnet.qore.host (no CORS on the public endpoint)
const EXPLORER_TX = "https://explore.qore.network/tx/";

const PRESETS: { label: string; address: Address }[] = [
  { label: "fUSD (testnet)", address: "0x97143B771D34ddb9130b807b135Ae675A5a963CA" },
  ...(DEMO_PERMIT_TOKEN ? [{ label: "Demo EIP-2612 token", address: DEMO_PERMIT_TOKEN }] : []),
];

const REMEDY: Record<EvmWindowRejection, string> = {
  "no-pqc-key": "This account has no registered ML-DSA-87 key.",
  "no-window": "No EVM authorisation window is open for this account.",
  exhausted: "The window ran out of blocks, transactions or value (or is scoped to another contract).",
  invalid: "The chain refused the window parameters.",
};

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

function Row({ ok, bad, label, note }: { ok?: boolean; bad?: boolean; label: string; note: string }) {
  return (
    <li className={bad ? "bad" : ok ? "ok" : "neutral"}>
      <b>{label}</b>
      <span>{note}</span>
    </li>
  );
}

function Verdict({ flags }: { flags: number }) {
  if (!has(flags, FLAGS.HAS_CODE)) return <div className="verdict neutral">No contract at this address on qorechain-diana.</div>;
  const exposed = isExposed(flags);
  return (
    <>
      <div className={`verdict ${exposed ? "bad" : "ok"}`}>
        {exposed ? (
          <>
            <b>Exposed.</b> This token accepts ECDSA-signed approvals. A leaked secp256k1 key can sign a <code>permit</code> that
            anyone relays, and QoreChain's EVM window does not stop it, because the owner sends no transaction.
          </>
        ) : (
          <>
            <b>Not exposed.</b> No ECDSA <code>permit</code> found. Approvals for this token need a transaction, which on QoreChain
            needs your ML-DSA-87 key and an EVM window.
          </>
        )}
      </div>
      <ul className="checks">
        <Row bad={has(flags, FLAGS.EIP2612_SELECTOR_IN_CODE)} ok={!has(flags, FLAGS.EIP2612_SELECTOR_IN_CODE)} label="EIP-2612 permit in code" note="permit(owner, spender, value, deadline, v, r, s)" />
        <Row bad={has(flags, FLAGS.DAI_PERMIT_SELECTOR_IN_CODE)} ok={!has(flags, FLAGS.DAI_PERMIT_SELECTOR_IN_CODE)} label="DAI-style permit in code" note="permit(holder, spender, nonce, expiry, allowed, v, r, s)" />
        <Row bad={has(flags, FLAGS.DOMAIN_SEPARATOR_CALLABLE)} ok={!has(flags, FLAGS.DOMAIN_SEPARATOR_CALLABLE)} label="DOMAIN_SEPARATOR() answers" note="also catches permit tokens behind a proxy" />
        <Row label="nonces(address) answers" note={has(flags, FLAGS.NONCES_CALLABLE) ? "yes" : "no"} />
        <Row label="eip712Domain() answers" note={has(flags, FLAGS.EIP712_DOMAIN_CALLABLE) ? "yes (ERC-5267)" : "no"} />
      </ul>
    </>
  );
}

function PqStatus({ flags }: { flags: number }) {
  const reg = has(flags, FLAGS.PQC_KEY_REGISTERED);
  const proven = has(flags, FLAGS.PQC_POSSESSION_PROVEN);
  return (
    <ul className="checks">
      <Row ok={reg} bad={!reg} label="ML-DSA-87 key registered" note={reg ? "yes" : "no: QoreX registers it on your first native send"} />
      <Row ok={proven} bad={reg && !proven} label="Possession proven" note={proven ? "yes" : "no: contracts that check possession will refuse this key"} />
    </ul>
  );
}

function WindowStatus({ address }: { address: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["evm-window", address],
    queryFn: () => evmWindowStatus({ rest: REST, address }),
    refetchInterval: 10_000,
  });
  if (isLoading) return <span>reading…</span>;
  if (error) return <span>could not read: {error.message}</span>;
  if (!data?.found) return <span className="pill neutral">none (not needed for QoreX native records)</span>;
  return (
    <span className={`pill ${data.live ? "ok" : "bad"}`}>
      {data.live ? "live" : "not usable"}: {data.remainingBlocks.toString()} blocks, {data.remainingTxs.toString()} txs left
    </span>
  );
}

export function App() {
  const client = usePublicClient({ chainId: qorechainTestnet.id });
  const qc = useQueryClient();
  const [input, setInput] = useState<string>(PRESETS[0].address);
  const token = isAddress(input) ? (input as Address) : undefined;

  // QoreX native account (the registered, hybrid-signing account)
  const [qorex, setQorex] = useState<{ qor: string; evm: Address; name?: string }>();
  const [connectError, setConnectError] = useState<string>();
  const [recording, setRecording] = useState(false);
  const [recordResult, setRecordResult] = useState<{ txHash?: string; error?: string }>();

  // Optional: an EVM wallet (e.g. MetaMask with an open window) for the registry's record() path
  const evm = useAccount();
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });
  const rejection = write.error ? classifyEvmWindowRejection(write.error) : undefined;

  const who = qorex?.evm ?? evm.address ?? zeroAddress;
  const scan = useQuery({
    queryKey: ["scan", token, who],
    queryFn: () => scanInBrowser(client!, token!, who),
    enabled: !!client && !!token,
  });
  const onChain = useReadContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: "scan",
    args: token ? [token, who] : undefined,
    query: { enabled: !!REGISTRY && !!token },
  });
  const journal = useQuery({
    queryKey: ["journal", JOURNAL],
    queryFn: () => readJournal(REST, JOURNAL!),
    enabled: !!JOURNAL,
    refetchInterval: 8000,
  });
  const flags = onChain.data !== undefined ? Number(onChain.data) : scan.data;

  async function onConnect() {
    setConnectError(undefined);
    try {
      setQorex(await connectQorex());
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onRecordQorex() {
    if (!qorex || !token || flags === undefined || !JOURNAL) return;
    setRecording(true);
    setRecordResult(undefined);
    try {
      const res = await recordWithQorex({ from: qorex.qor, journal: JOURNAL, token, flags, exposed: isExposed(flags) });
      setRecordResult(res.code === 0 ? { txHash: res.txHash } : { txHash: res.txHash, error: `chain returned code ${res.code}` });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["journal"] }), 4000);
    } catch (e) {
      setRecordResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setRecording(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>Permit Exposure Check</h1>
        <p className="lead">
          QoreChain's EVM windows protect <i>transactions</i>, not <i>signatures</i>. Tokens with an ECDSA <code>permit</code> let a
          leaked key approve spending without the owner sending anything. Check a token, check your account, and record the result
          with a post-quantum (hybrid-signed) transaction.
        </p>
      </header>

      <section className="card">
        <h2>1 · Token</h2>
        <div className="row">
          <input value={input} onChange={(e) => setInput(e.target.value.trim())} placeholder="0x… token address" spellCheck={false} />
        </div>
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.address} type="button" className="ghost" onClick={() => setInput(p.address)}>
              {p.label}
            </button>
          ))}
        </div>
        {!token && <p className="small">Enter a 0x address.</p>}
        {token && flags === undefined && <p className="small">Scanning…</p>}
        {scan.error && <div className="error">Scan failed: {scan.error.message}</div>}
        {token && flags !== undefined && <Verdict flags={flags} />}
        {REGISTRY && onChain.data !== undefined && scan.data !== undefined && (
          <p className="small">
            On-chain scan by the registry {Number(onChain.data) === scan.data ? "matches" : "differs from"} the in-browser scan.
          </p>
        )}
      </section>

      <section className="card">
        <h2>2 · Your account</h2>
        {!qorex ? (
          <>
            <button type="button" onClick={onConnect}>
              Connect QoreX
            </button>
            {!qorexNative() && <p className="small">QoreX not detected. Install it, switch it to Testnet, then reload.</p>}
            {connectError && <div className="error">{connectError}</div>}
          </>
        ) : (
          <>
            <div className="kv">
              <div>QoreX account</div>
              <code>{qorex.qor}</code>
              <div>Same account (0x)</div>
              <code>{qorex.evm}</code>
              <div>EVM window</div>
              <WindowStatus address={qorex.qor} />
            </div>
            {flags !== undefined && <PqStatus flags={flags} />}
          </>
        )}
      </section>

      <section className={`card ${qorex && JOURNAL ? "" : "dim"}`}>
        <h2>3 · Record on chain</h2>
        <p className="small">
          QoreX signs one native transaction with <b>secp256k1 + ML-DSA-87</b> (hybrid): a 1 uqor transfer to the registry's account,
          with the verdict in the memo.
        </p>
        <button type="button" disabled={!qorex || !token || flags === undefined || !JOURNAL || recording} onClick={onRecordQorex}>
          {recording ? "Approve in QoreX…" : "Record with QoreX (hybrid-signed)"}
        </button>
        {recordResult?.txHash && (
          <p className="small">
            tx{" "}
            <a href={`${EXPLORER_TX}${recordResult.txHash}`} target="_blank" rel="noreferrer">
              <code>{short(recordResult.txHash)}</code>
            </a>
          </p>
        )}
        {recordResult?.error && <div className="error">Refused: {recordResult.error}</div>}

        {JOURNAL && (
          <>
            <h3>Recorded checks</h3>
            {journal.error && <p className="small">Could not read records: {journal.error.message}</p>}
            <ul className="entries">
              {(journal.data ?? []).map((c) => (
                <li key={c.txHash}>
                  <span className={c.exposed ? "pill bad" : "pill ok"}>{c.exposed ? "exposed" : "safe"}</span> <code>{short(c.token)}</code>{" "}
                  checked by <code>{short(c.from)}</code> ·{" "}
                  <a href={`${EXPLORER_TX}${c.txHash}`} target="_blank" rel="noreferrer">
                    {new Date(c.time).toUTCString()}
                  </a>
                </li>
              ))}
              {journal.data?.length === 0 && <li className="small">No records yet. Be the first.</li>}
            </ul>
          </>
        )}

        <details className="alt">
          <summary>Advanced: record through the EVM registry with an EVM wallet (MetaMask + open window)</summary>
          <ConnectButton chainStatus="icon" showBalance={false} />
          <button
            type="button"
            disabled={!evm.isConnected || !REGISTRY || !token || write.isPending}
            onClick={() => write.writeContract({ address: REGISTRY!, abi: registryAbi, functionName: "record", args: [token!] })}
          >
            {write.isPending ? "Approve in your wallet…" : "registry.record(token)"}
          </button>
          {write.data && (
            <p className="small">
              tx <code>{short(write.data)}</code>{" "}
              {receipt.isLoading ? "waiting…" : receipt.data ? `${receipt.data.status} in block ${receipt.data.blockNumber}` : ""}
            </p>
          )}
          {write.error && <div className="error">Refused: {rejection ? REMEDY[rejection] : write.error.message.split("\n")[0]}</div>}
          <p className="small">QoreX's EVM connection cannot send transactions yet; use the QoreX button above.</p>
        </details>
      </section>

      <footer>Testnet only (qorechain-diana). Testnet QOR has no value.</footer>
    </div>
  );
}
