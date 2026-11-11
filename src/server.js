import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Chain, TransferError, isAddress } from "./chain.js";
import { addressFromPublicKey, generateWallet } from "./keys.js";
import { blockBatchSize, isHash, peerRules, PeerSync, readPeerUrls } from "./peers.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);
const maxBodyBytes = 4096;
const peers = readPeerUrls(process.env.AUREA_PEERS ?? "");

const assets = new Map([
  ["/", ["../dashboard/index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["../dashboard/dist/app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["../dashboard/dist/app.js", "text/javascript; charset=utf-8"]],
]);

for (const [route, [path, type]] of assets) {
  try {
    assets.set(route, { body: readFileSync(new URL(path, import.meta.url)), type });
  } catch (error) {
    throw new Error("Could not load the explorer. Run npm run build before starting the node.", { cause: error });
  }
}

const databasePath = process.env.AUREA_DB ?? "data/aurea.sqlite3";
const keyPath = process.env.AUREA_NODE_KEY ??
  (process.env.AUREA_DB === undefined ? "secrets/aurea.sqlite3.node-key.pem" : undefined);
if (process.env.AUREA_DB === undefined) mkdirSync("data", { recursive: true });
if (process.env.AUREA_DB === undefined && process.env.AUREA_NODE_KEY === undefined) {
  mkdirSync("secrets", { recursive: true, mode: 0o700 });
}
const chain = new Chain(databasePath, {
  keyPath,
  blockSubsidy: process.env.AUREA_BLOCK_SUBSIDY,
});
const minerAddress = addressFromPublicKey(chain.publicKey);
const peerSync = new PeerSync(chain, peers);
let rejectedTransfers = 0;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function queryInteger(params, key, fallback) {
  const value = params.get(key);
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return NaN;
  return Number(value);
}

function sendPeerBlocks(response, query) {
  const params = new URLSearchParams(query);
  const from = queryInteger(params, "from");
  const through = queryInteger(params, "through");
  const limit = queryInteger(params, "limit", blockBatchSize);
  const anchor = params.get("anchor");
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) ||
      from > through || !Number.isSafeInteger(limit) || limit < 1 || limit > blockBatchSize ||
      !isHash(anchor)) {
    json(response, 400, { message: "Provide a block range, an anchor hash, and a limit of up to 32 blocks." });
    return;
  }
  if (chain.hashAt(through) !== anchor) {
    json(response, 409, { message: "The requested branch is no longer the active chain." });
    return;
  }
  json(response, 200, chain.blocks(from, through, limit));
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    request.resume();
    throw new TransferError("Send the transfer as application/json.", 415);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.resume();
      throw new TransferError("Transfer request is too large.", 413);
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TransferError("Transfer body must be valid JSON.");
  }
}

const server = createServer({ requestTimeout: 10_000 }, async (request, response) => {
  const actualPort = server.address().port;
  const address = host + ":" + actualPort;
  const authority = request.headers.host;
  const allowed = [host, "localhost"].map((name) => actualPort === 80 ? name : name + ":" + actualPort);
  if (!allowed.includes(authority)) {
    json(response, 403, { message: "Use the local node address." });
    return;
  }

  const [path, query] = request.url.split("?", 2);
  if (request.method === "GET") {
    const asset = assets.get(path);
    if (asset) {
      response.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
      response.end(asset.body);
      return;
    }
    if (path === "/api/status") {
      json(response, 200, {
        ...chain.status(),
        address,
        node_public_key: chain.publicKey,
        miner_account: chain.account(minerAddress),
        rejected_transfers: rejectedTransfers,
        peers: peerSync.status(),
      });
      return;
    }
    if (path === "/api/peer/tip" || path === "/api/peer/blocks") {
      if (request.headers["x-aurea-peer-rules"] !== peerRules) {
        json(response, 426, { message: "Incompatible ledger rules." });
      } else if (path === "/api/peer/tip") {
        json(response, 200, {
          genesis: chain.genesisHash,
          tip: chain.tip,
          rules: peerRules,
          block_subsidy: chain.blockSubsidy,
        });
      } else {
        sendPeerBlocks(response, query);
      }
      return;
    }
    if (path.startsWith("/api/accounts/")) {
      const address = path.slice("/api/accounts/".length);
      if (!isAddress(address)) {
        json(response, 400, { message: "Account address must contain 40 lowercase hex characters." });
        return;
      }
      json(response, 200, chain.account(address));
      return;
    }
  }

  if (request.method === "POST" && (path === "/api/transfers" || path === "/api/wallets")) {
    const isTransfer = path === "/api/transfers";
    try {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== "http://" + authority) {
        request.resume();
        throw new TransferError("Use the local explorer for this request.", 403);
      }
      if (!isTransfer) {
        request.resume();
        json(response, 201, generateWallet());
        return;
      }
      const transfer = await readJson(request);
      const result = await chain.submit(transfer);
      json(response, 201, result);
    } catch (error) {
      if (error instanceof TransferError) {
        if (isTransfer) rejectedTransfers++;
        json(response, error.status, { message: error.message });
        return;
      }
      console.error(error);
      json(response, 500, { message: isTransfer
        ? "Could not commit the transfer. Check recent blocks before retrying."
        : "Could not generate a wallet." });
    }
    return;
  }

  json(response, 404, { message: "Route not found." });
});

server.listen(port, host, () => {
  const localUrl = new URL("http://" + host + ":" + server.address().port).origin;
  peerSync.start(localUrl);
  console.log("Aurea node listening at " + localUrl);
});

function shutdown() {
  const stopped = peerSync.stop();
  server.close(async () => {
    await stopped;
    await chain.close();
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
