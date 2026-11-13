import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import TransferForm from "./transfer.jsx";
import Wallets from "./wallet.jsx";
import "./style.css";

const number = (value) => value == null ? "—" : BigInt(value).toLocaleString();
const unitLabel = (value) => BigInt(value) === 1n ? "unit" : "units";
const units = (value) => value == null ? "—" : number(value) + " " + unitLabel(value);
const shortHex = (value) => value ? value.slice(0, 8) + "…" + value.slice(-6) : "—";
const tabs = [
  { id: "overview", label: "Overview" },
  { id: "blocks", label: "Blocks" },
  { id: "transfers", label: "Transfers" },
  { id: "wallets", label: "Wallets" },
];

function useNodeStatus() {
  const [state, setState] = useState({ data: null, updated: null, error: false });

  useEffect(() => {
    const controller = new AbortController();
    let timer;

    async function poll() {
      try {
        const response = await fetch("/api/status", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Status request failed");
        const data = await response.json();
        if (!controller.signal.aborted) {
          setState({ data, updated: new Date(), error: false });
        }
      } catch {
        if (!controller.signal.aborted) {
          setState((previous) => ({ ...previous, error: true }));
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
      }
    }

    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return state;
}

function Metric({ label, value, detail }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail">{detail}</div>
    </div>
  );
}

function Block({ block, subsidy }) {
  const { sender, recipient, amount, nonce } = block.transfer;
  const miner = block.minerPublicKey;
  return (
    <details className="block">
      <summary>
        <span className="block-height"><span className="chevron" aria-hidden="true">›</span> #{number(block.height)}</span>
        <code title={block.hash}>{shortHex(block.hash)}</code>
        <span className="route">
          <code title={sender}>{shortHex(sender)}</code>
          <span className="arrow" aria-label="to">→</span>
          <code title={recipient}>{shortHex(recipient)}</code>
        </span>
        <span className="block-miner"><span>Mined by </span><code title={miner}>{miner ? shortHex(miner) : "Unknown"}</code></span>
        <span className="block-amount">{number(amount)} <span>{unitLabel(amount)}</span></span>
      </summary>
      <dl className="block-detail">
        <div><dt>Block hash</dt><dd><code>{block.hash}</code></dd></div>
        <div><dt>Parent hash</dt><dd><code>{block.parent}</code></dd></div>
        <div><dt>Sender</dt><dd><code>{sender}</code></dd></div>
        <div><dt>Recipient</dt><dd><code>{recipient}</code></dd></div>
        <div><dt>Transfer nonce</dt><dd><code>{number(nonce)}</code></dd></div>
        <div><dt>Proof nonce</dt><dd><code>{number(block.proofNonce)}</code></dd></div>
        <div><dt>Mining node public key</dt><dd><code>{miner ?? "Unknown"}</code></dd></div>
        {miner && subsidy != null && <div><dt>Block subsidy</dt><dd>{units(subsidy)}</dd></div>}
      </dl>
    </details>
  );
}

function Overview({ data }) {
  const tip = data?.tip;
  const miner = data?.miner_account;
  const peers = data?.peers ?? [];
  return (
    <>
      <section className="metrics" aria-label="Chain overview">
        <Metric label="Block height" value={number(tip?.height)} detail={data ? number(data.chain_work) + " cumulative work" : "Active chain"} />
        <Metric label="PoW difficulty" value={number(data?.difficulty)} detail="Leading zeros in the block hash" />
        <Metric label="Miner balance" value={number(miner?.balance)} detail={data?.mining ? "Mining…" : "Subsidy · " + units(data?.block_subsidy) + " per block"} />
        <Metric label="Rejected requests" value={number(data?.rejected_transfers)} detail="Transfer requests rejected since startup" />
      </section>
      <section className="node-details" aria-label="Node details">
        <div><span className="detail-label">HTTP listener</span><code>{data?.address ?? "—"}</code></div>
        <div>
          <span className="detail-label">Peers</span>
          {peers.length ? peers.map(({ url, status }) => (
            <div key={url}><code>{new URL(url).host}</code> · {status}</div>
          )) : data ? "Standalone" : "—"}
        </div>
        <div className="tip">
          <div><span className="detail-label">Tip hash</span><code>{tip?.hash ?? "—"}</code></div>
          <div><span className="detail-label">Miner address</span><code>{miner?.address ?? "—"}</code></div>
        </div>
      </section>
    </>
  );
}

function RecentBlocks({ blocks, ready, subsidy }) {
  return (
    <section className="activity" aria-labelledby="activity-title">
      <div className="section-head">
        <div><h2 id="activity-title">Recent blocks</h2><p>Each block contains one transfer. Expand a block to see its subsidy and other details.</p></div>
        {ready && <span className="count">{blocks.length} shown</span>}
      </div>
      {blocks.length ? (
        <>
          <div className="column-head" aria-hidden="true"><span>Block</span><span>Hash</span><span>Transfer</span><span>Mined by</span><span>Transfer amount</span></div>
          {blocks.map((block) => <Block key={block.hash} block={block} subsidy={subsidy} />)}
        </>
      ) : (
        <p className="empty">{ready ? "Send a transfer from the Transfers tab to mine the first block." : "Waiting for node data…"}</p>
      )}
    </section>
  );
}

function ExplorerTabs({ selected, onSelect }) {
  const buttons = useRef([]);

  function handleKey(event, index) {
    const nextIndex = {
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    onSelect(tabs[nextIndex].id);
    buttons.current[nextIndex].focus();
  }

  return (
    <div className="explorer-tabs" role="tablist" aria-label="Node explorer sections">
      {tabs.map(({ id, label }, index) => (
        <button
          key={id}
          ref={(button) => { buttons.current[index] = button; }}
          type="button"
          role="tab"
          id={id + "-tab"}
          aria-controls={id + "-panel"}
          aria-selected={selected === id}
          tabIndex={selected === id ? 0 : -1}
          onClick={() => onSelect(id)}
          onKeyDown={(event) => handleKey(event, index)}
        >{label}</button>
      ))}
    </div>
  );
}

function App() {
  const { data, updated, error } = useNodeStatus();
  const [selected, setSelected] = useState("overview");
  const tipHash = data?.tip?.hash;
  const miner = data?.miner_account;
  const blocks = data?.recent_blocks ?? [];
  const status = error ? "Disconnected" : data ? "Live" : "Connecting";
  const panels = {
    overview: <Overview data={data} />,
    blocks: <RecentBlocks blocks={blocks} ready={Boolean(data)} subsidy={data?.block_subsidy} />,
    transfers: <TransferForm tipHash={tipHash} recentBlocks={blocks} minerAddress={miner?.address} />,
    wallets: <Wallets miner={miner} tipHash={tipHash} active={selected === "wallets"} />,
  };

  return (
    <>
      <header className="topbar">
        <div className="shell bar-inner">
          <div className="brand"><span className="brand-mark" aria-hidden="true">A</span>Aurea</div>
          <div className="bar-meta">
            <div className="header-balance">Miner balance <strong>{units(miner?.balance)}</strong></div>
            <span className={"status " + (error ? "offline" : data ? "live" : "")} role="status"><i />{status}</span>
          </div>
        </div>
      </header>
      <main className="shell">
        {error && <p className="notice" role="alert">Could not reach the node. Retrying automatically.</p>}
        <ExplorerTabs selected={selected} onSelect={setSelected} />
        <div className="node-meta">
          <div className="node-identity"><span>Node</span><code aria-label="Node public key">{data?.node_public_key ?? "—"}</code></div>
          {updated && <time dateTime={updated.toISOString()}>Updated {updated.toLocaleTimeString()}</time>}
        </div>
        {tabs.map(({ id }) => (
          <div key={id} id={id + "-panel"} role="tabpanel" aria-labelledby={id + "-tab"} hidden={selected !== id} tabIndex={0}>
            {panels[id]}
          </div>
        ))}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
