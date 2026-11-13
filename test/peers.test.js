import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Chain } from "../src/chain.js";
import { addressFromPublicKey } from "../src/keys.js";
import { PeerSync, blockBatchSize, peerRules } from "../src/peers.js";

const alice = "01".repeat(20);
const bob = "02".repeat(20);
const carol = "03".repeat(20);
const peerUrl = "http://127.0.0.1:8081";

function send(chain, recipient, nonce) {
  return chain.submit({ sender: alice, recipient, amount: "1", nonce: String(nonce) });
}

async function waitForStatuses(sync, ...expected) {
  const deadline = Date.now() + 8000;
  let statuses;
  do {
    statuses = sync.status().map(({ status }) => status);
    if (statuses.every((status, index) => status === expected[index])) {
      assert.deepEqual(statuses, expected);
      return;
    }
    await delay(20);
  } while (Date.now() < deadline);
  assert.deepEqual(statuses, expected);
}

test("peer sync holds a tie, then retries a paged reorg from the shared ancestor", async (t) => {
  const local = new Chain(":memory:");
  const peer = new Chain(":memory:");
  const sync = new PeerSync(local, [peerUrl]);
  t.after(async () => {
    await sync.stop();
    await Promise.all([local.close(), peer.close()]);
  });

  const genesis = local.tip;
  await send(local, bob, 0);
  await send(local, bob, 1);
  async function* sharedBlocks() {
    yield local.blocks(1, 2, 2);
  }
  await peer.adoptBranch(genesis, local.tip, sharedBlocks());
  await send(local, carol, 2);
  await send(local, carol, 3);
  const oldTip = local.tip;

  const secondPage = 3 + blockBatchSize;
  for (let height = 3; height <= secondPage + 1; height++) {
    await send(peer, bob, height - 1);
  }
  let advertised = { height: 4, hash: peer.hashAt(4) };
  const interruptedTip = { height: secondPage, hash: peer.hashAt(secondPage) };
  const pages = [];
  const headers = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    headers.push(options.headers["X-Aurea-Peer-Rules"]);
    if (pathname === "/api/peer/tip") {
      return Response.json({
        genesis: peer.genesisHash,
        tip: advertised,
        rules: peerRules,
        block_subsidy: peer.blockSubsidy,
      });
    }

    const from = Number(searchParams.get("from"));
    const through = Number(searchParams.get("through"));
    const limit = Number(searchParams.get("limit"));
    const anchor = searchParams.get("anchor");
    if (limit > 1) pages.push({ from, through, limit, anchor });
    if (pathname !== "/api/peer/blocks" || anchor !== advertised.hash || through !== advertised.height) {
      return new Response(null, { status: 400 });
    }
    if (from === secondPage && anchor === interruptedTip.hash) {
      advertised = peer.tip;
      return new Response(null, { status: 409 });
    }
    return Response.json(peer.blocks(from, through, limit));
  });
  sync.start("http://127.0.0.1:8082");

  await waitForStatuses(sync, "Equal work fork");
  assert.deepEqual(local.tip, oldTip);
  assert.equal(pages.length, 0);

  advertised = interruptedTip;
  await waitForStatuses(sync, "Tip changed");
  assert.deepEqual(local.tip, oldTip);
  assert.equal(local.account(carol).balance, "2");

  await waitForStatuses(sync, "Synced");
  assert.deepEqual(local.tip, peer.tip);
  assert.equal(local.account(carol).balance, "0");
  assert.equal(local.account(addressFromPublicKey(local.publicKey)).balance, "2");
  assert.equal(local.account(addressFromPublicKey(peer.publicKey)).balance, String(peer.tip.height - 2));
  assert.ok(headers.length > 0 && headers.every((value) => value === peerRules));
  assert.deepEqual(pages, [
    { from: 3, through: interruptedTip.height, limit: blockBatchSize, anchor: interruptedTip.hash },
    { from: secondPage, through: interruptedTip.height, limit: blockBatchSize, anchor: interruptedTip.hash },
    { from: 3, through: peer.tip.height, limit: blockBatchSize, anchor: peer.tip.hash },
    { from: secondPage, through: peer.tip.height, limit: blockBatchSize, anchor: peer.tip.hash },
  ]);
});

test("peer sync declines incompatible rules and subsidies before downloading blocks", async (t) => {
  const local = new Chain(":memory:");
  const sync = new PeerSync(local, [peerUrl, "http://127.0.0.1:8083"]);
  t.after(async () => {
    await sync.stop();
    await local.close();
  });
  const genesis = local.tip;
  const requestedPaths = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    requestedPaths.push(url.pathname);
    if (url.port === "8083") return new Response(null, { status: 426 });
    return Response.json({
      genesis: genesis.hash,
      tip: { height: 10, hash: "0".repeat(64) },
      rules: peerRules,
      block_subsidy: "3",
    });
  });
  sync.start("http://127.0.0.1:8082");

  await waitForStatuses(sync, "Different block subsidy", "Incompatible rules");
  assert.deepEqual(local.tip, genesis);
  assert.deepEqual(requestedPaths, ["/api/peer/tip", "/api/peer/tip"]);
});
