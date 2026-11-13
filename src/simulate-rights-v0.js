import { loadNodeIdentity } from "./keys.js";
import { config, RightsChain, slotType } from "./rights-v0.js";

const miners = [loadNodeIdentity(":memory:"), loadNodeIdentity(":memory:")];
const chain = new RightsChain();
const offline = process.argv.includes("--offline");
const counts = { POW: 0, RIGHTS: 0, fallback: 0 };

for (let height = 1; height <= 100; height++) {
  const winner = chain.selectedMiner();
  const scheduled = miners.find((miner) => miner.publicKey === winner);
  const fallback = slotType(height) === "RIGHTS" && (!scheduled || offline);
  const block = scheduled && !offline
    ? chain.produce(scheduled, { kind: "RIGHTS" })
    : chain.produce(miners[height % miners.length], {
      timestamp: chain.tip.timestamp + (scheduled ? config.fallbackDelay : 1),
    });
  counts[block.kind]++;
  if (fallback) counts.fallback++;
}

console.log({ ...counts, height: chain.tip.height, chainWork: chain.chainWork.toString() });
