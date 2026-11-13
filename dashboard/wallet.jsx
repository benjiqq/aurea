import React, { useEffect, useState } from "react";
import { addressPattern, normalizeAddress } from "./account-address.js";

function WalletGenerator({ onGenerated }) {
  const [wallet, setWallet] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    setGenerating(true);
    setError("");
    try {
      const response = await fetch("/api/wallets", { method: "POST", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Wallet request failed");
      const generated = await response.json();
      setWallet(generated);
      onGenerated(generated.address);
    } catch {
      setError("Could not generate a wallet. Try again.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="transfer" aria-labelledby="wallet-title">
      <div className="section-head">
        <div><h2 id="wallet-title">Wallet generator</h2><p>Create a new address and Ed25519 keypair.</p></div>
        <button className="secondary-button" type="button" onClick={generate} disabled={generating}>
          {generating ? "Generating…" : "Generate wallet"}
        </button>
      </div>
      {(wallet || error) && (
        <div className="wallet-result">
          {error && <p className="transfer-result failed" role="alert">{error}</p>}
          {wallet && (
            <>
              <dl className="wallet-fields" aria-live="polite">
                <div><dt className="detail-label">Wallet address</dt><dd><code>{wallet.address}</code></dd></div>
                <div><dt className="detail-label">Public key</dt><dd><code>{wallet.publicKey}</code></dd></div>
              </dl>
              <p className="detail-label">Save the private key before generating another wallet.</p>
              <details key={wallet.address} className="wallet-secret">
                <summary>Show private key</summary>
                <textarea aria-label="Private key" rows={4} readOnly value={wallet.privateKey} spellCheck={false} />
              </details>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function AccountDetails({ account }) {
  return (
    <dl className="wallet-fields wallet-account">
      <div><dt className="detail-label">Address</dt><dd><code>{account.address}</code></dd></div>
      <div><dt className="detail-label">Balance</dt><dd>{BigInt(account.balance).toLocaleString()} units</dd></div>
      <div><dt className="detail-label">Next transfer nonce</dt><dd>{BigInt(account.nonce).toLocaleString()}</dd></div>
    </dl>
  );
}

export default function Wallets({ miner, tipHash, active }) {
  const [draft, setDraft] = useState("");
  const [selection, setSelection] = useState(null);
  const [lookup, setLookup] = useState(null);
  const result = lookup?.selection === selection ? lookup : null;

  useEffect(() => {
    if (!active || !selection) return;
    const controller = new AbortController();
    async function loadAccount() {
      try {
        const response = await fetch("/api/accounts/" + selection.address, {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error("Account lookup failed");
        const account = await response.json();
        if (!controller.signal.aborted) setLookup({ selection, account });
      } catch {
        if (!controller.signal.aborted) setLookup({ selection, error: "Could not check this address. Try again." });
      }
    }
    loadAccount();
    return () => controller.abort();
  }, [active, selection, tipHash]);

  function viewAddress(value) {
    const address = normalizeAddress(value);
    if (!/^[0-9a-f]{40}$/.test(address)) return;
    setDraft(address);
    setSelection({ address });
  }

  return (
    <>
      <section className="transfer wallet-overview" aria-labelledby="wallet-overview-title">
        <div className="section-head">
          <div><h2 id="wallet-overview-title">Wallet overview</h2><p>Check the balance and next transfer nonce for an address.</p></div>
        </div>
        <div className="wallet-overview-grid">
          <div>
            <h3>Miner account</h3>
            {miner ? <AccountDetails account={miner} /> : <p className="detail-label">Waiting for node data…</p>}
          </div>
          <div>
            <h3>Address lookup</h3>
            <form onSubmit={(event) => {
              event.preventDefault();
              viewAddress(draft);
            }}>
              <label htmlFor="wallet-lookup-address">Wallet address</label>
              <div className="wallet-lookup-input">
                <input id="wallet-lookup-address" value={draft} onChange={(event) => setDraft(event.target.value)}
                  placeholder="40 hex characters" pattern={addressPattern} maxLength={42}
                  autoComplete="off" spellCheck={false} required />
                <button type="submit" className="secondary-button">Check address</button>
              </div>
            </form>
            {selection && (
              <div className="wallet-lookup-result" aria-live="polite">
                {result?.account ? <AccountDetails account={result.account} /> :
                  <p className={result?.error ? "transfer-result failed" : "detail-label"}>
                    {result?.error ?? "Checking address…"}
                  </p>}
              </div>
            )}
          </div>
        </div>
      </section>
      <WalletGenerator onGenerated={viewAddress} />
    </>
  );
}
