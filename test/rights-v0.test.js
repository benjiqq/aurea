import assert from "node:assert/strict";
import { test } from "node:test";
import { loadNodeIdentity } from "../src/keys.js";
import { config, RightsChain } from "../src/rights-v0.js";

const miner = () => loadNodeIdentity(":memory:");
function advance(chain, through, identity, online = true) {
  while (chain.tip.height < through) {
    const winner = chain.selectedMiner();
    if (winner && online) {
      assert.equal(winner, identity.publicKey);
      chain.produce(identity, { kind: "RIGHTS" });
    } else {
      chain.produce(identity, {
        timestamp: chain.tip.timestamp + (winner ? config.fallbackDelay : 1),
      });
    }
  }
}

test("PoW credits activate after 10 heights and expire after 100 eligible heights", () => {
  const chain = new RightsChain();
  const block = chain.produce(miner());
  assert.deepEqual(chain.activeRights(10), []);
  const right = { id: block.hash, owner: block.minerPublicKey, activeFrom: 11, expiresAt: 111 };
  assert.deepEqual(chain.activeRights(11), [right]);
  assert.deepEqual(chain.activeRights(110), [right]);
  assert.deepEqual(chain.activeRights(111), []);
});

test("only the selected miner can sign an on-time rights block; PoW waits for the fallback boundary", () => {
  const chain = new RightsChain();
  const owner = miner();
  const outsider = miner();
  advance(chain, 18, owner);
  const { timestamp } = chain.tip;
  const work = chain.chainWork;
  assert.throws(() => chain.produce(outsider, { kind: "RIGHTS" }), /Wrong rights miner/);
  assert.throws(() => chain.produce(owner, { kind: "RIGHTS", timestamp: timestamp + 10 }), /timed out/);
  assert.throws(() => chain.produce(outsider, { timestamp: timestamp + 9 }), /too early/);

  const replay = new RightsChain();
  assert.equal(replay.adoptBranch(chain.blocks), true);
  assert.equal(replay.selectedMiner(), owner.publicKey);
  const block = chain.produce(owner, { kind: "RIGHTS" });
  assert.throws(() => replay.append({ ...block, minerSignature: "0".repeat(128) }), /Invalid miner signature/);
  replay.produce(outsider, { timestamp: timestamp + 10 });

  assert.equal(chain.chainWork, work);
  assert.ok(replay.chainWork > work);
  assert.ok(!chain.activeRights(29).some((right) => right.id === block.hash));
  assert.ok(replay.activeRights(29).some((right) => right.id === replay.tip.hash));
});

test("a shorter branch with more PoW replaces the tip and its rights", () => {
  const chain = new RightsChain();
  const fork = new RightsChain();
  const first = miner();
  const second = miner();
  advance(chain, 29, first);
  advance(fork, 27, second, false);
  assert.equal(chain.chainWork, fork.chainWork);
  assert.equal(chain.adoptBranch(fork.blocks), false);

  advance(fork, 28, second, false);
  assert.equal(chain.adoptBranch(fork.blocks), true);
  assert.equal(chain.tip.height, 28);
  assert.equal(chain.selectedMiner(), second.publicKey);
  assert.ok(chain.activeRights().every((right) => right.owner === second.publicKey));
});
