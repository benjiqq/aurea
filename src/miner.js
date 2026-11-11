import { parentPort, workerData } from "node:worker_threads";
import { meetsTarget, proofHash } from "./consensus.js";

for (let proofNonce = 0; Number.isSafeInteger(proofNonce); proofNonce++) {
  const hash = proofHash(workerData, proofNonce);
  if (meetsTarget(hash)) {
    parentPort.postMessage({ proofNonce, hash });
    break;
  }
}
