import React, { useEffect, useState } from "react";
import { addressPattern, normalizeAddress as address } from "./account-address.js";

const format = (value) => BigInt(value).toLocaleString();
const demoSender = "01".repeat(20);
const demoRecipient = "02".repeat(20);

export default function TransferForm({ tipHash, recentBlocks, minerAddress }) {
  const [sender, setSender] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [lookup, setLookup] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const senderAddress = address(sender);
  const validSender = /^[0-9a-f]{40}$/.test(senderAddress);
  const senderLookup = lookup?.address === senderAddress ? lookup : null;
  const account = senderLookup?.account;
  const unfundedMiner = senderAddress === minerAddress && account?.balance === "0";
  const replacement = result?.hash && recentBlocks.find((block) => block.height === result.height);
  const replaced = replacement && replacement.hash !== result.hash;

  useEffect(() => {
    if (!validSender) return;
    const controller = new AbortController();
    async function loadAccount() {
      try {
        const response = await fetch("/api/accounts/" + senderAddress, {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        const data = await response.json();
        if (!controller.signal.aborted) {
          setLookup(response.ok
            ? { address: senderAddress, account: data }
            : { address: senderAddress, message: data.message });
        }
      } catch {
        if (!controller.signal.aborted) {
          setLookup({ address: senderAddress, message: "Could not check the sender balance." });
        }
      }
    }
    loadAccount();
    return () => controller.abort();
  }, [senderAddress, validSender, refresh, tipHash]);

  function refreshAccount() {
    setLookup(null);
    setRefresh((value) => value + 1);
  }

  function prepareTransfer(from, to, units) {
    setSender(from);
    setRecipient(to);
    setAmount(units);
    setResult(null);
    refreshAccount();
  }

  async function submit(event) {
    event.preventDefault();
    if (sending || !account || unfundedMiner) return;

    setResult(null);
    setSending(true);
    try {
      const response = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: senderAddress,
          recipient: address(recipient),
          amount: amount.trim(),
          nonce: String(account.nonce),
        }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      if (!response.ok) {
        setResult({ error: true, message: data.message });
        if (response.status === 409) refreshAccount();
        return;
      }

      setLookup({ address: senderAddress, account: data.account });
      setAmount("");
      setResult({ height: data.height, hash: data.hash, message: "Transfer mined in block #" + format(data.height) + "." });
    } catch {
      setResult({ error: true, message: "Could not confirm the transfer. Check recent blocks before trying again." });
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="transfer" aria-labelledby="transfer-title">
      <div className="section-head">
        <div><h2 id="transfer-title">Send a transfer</h2><p>Move whole units between accounts on this unsigned local demo chain.</p></div>
        <div className="transfer-presets">
          <button type="button" className="secondary-button" onClick={() => prepareTransfer(demoSender, demoRecipient, "10")} disabled={sending}>Use demo accounts</button>
          <button type="button" className="secondary-button" onClick={() => prepareTransfer(demoSender, minerAddress, "10")} disabled={sending || !minerAddress}>Fund miner</button>
          <button type="button" className="secondary-button" onClick={() => prepareTransfer(minerAddress, "", "")} disabled={sending || !minerAddress}>Send from miner</button>
        </div>
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={sending}>
          <div className="transfer-fields">
            <label>
              Sender address
              <input value={sender} onChange={(event) => {
                const value = event.target.value;
                if (address(value) !== senderAddress) setLookup(null);
                setSender(value);
                setResult(null);
              }} name="sender" placeholder="40 hex characters" pattern={addressPattern} maxLength={42}
                autoComplete="off" spellCheck={false} aria-describedby="sender-balance" required />
            </label>
            <label>
              Recipient address
              <input value={recipient} onChange={(event) => setRecipient(event.target.value)}
                name="recipient" placeholder="40 hex characters" pattern={addressPattern} maxLength={42}
                autoComplete="off" spellCheck={false} required />
            </label>
            <label>
              Amount
              <input value={amount} onChange={(event) => setAmount(event.target.value)}
                name="amount" placeholder="0" inputMode="numeric" pattern="[0-9]{1,78}" maxLength={78}
                autoComplete="off" required />
            </label>
          </div>
          <div className="transfer-actions">
            <div className="sender-balance">
              <span id="sender-balance" role="status">
                {unfundedMiner ? "Miner balance is 0 units. Use Fund miner to prepare a deposit." :
                  account ? "Available: " + format(account.balance) + " units" :
                  senderLookup?.message ?? (validSender ? "Checking sender balance…" : "Enter a sender address to see its balance.")}
              </span>
              {senderLookup?.message && <button type="button" className="secondary-button" onClick={refreshAccount}>Check again</button>}
            </div>
            <button type="submit" className="primary-button" disabled={!account || unfundedMiner}>{sending ? "Mining…" : "Send transfer"}</button>
          </div>
        </fieldset>
        {replaced ? (
          <p className="transfer-result failed" role="alert">A chain reorganization replaced the original transfer block.</p>
        ) : result && (
          <p className={"transfer-result " + (result.error ? "failed" : "confirmed")} role={result.error ? "alert" : "status"}>{result.message}</p>
        )}
      </form>
    </section>
  );
}
