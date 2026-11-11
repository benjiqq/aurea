export const blockBatchSize = 32;
export const peerRules = "aurea-block-subsidy-v1";
const maxPeerResponseBytes = 64 * 1024;
const pollInterval = 1000;

export const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isHeight = (value) => Number.isSafeInteger(value) && value >= 0;

export function readPeerUrls(config) {
  const urls = config.split(",").map((url) => url.trim()).filter(Boolean);
  return [...new Set(urls.map((address) => {
    const url = new URL(address);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("AUREA_PEERS requires comma-separated loopback HTTP origins.");
    }
    url.hostname = "127.0.0.1";
    return url.origin;
  }))];
}

class PeerError extends Error {}

async function fetchJson(url, signal) {
  let response;
  try {
    response = await fetch(url, {
      redirect: "error",
      headers: { "X-Aurea-Peer-Rules": peerRules },
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    });
  } catch {
    throw new PeerError("Unreachable");
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 426) throw new PeerError("Incompatible rules");
    throw new PeerError(response.status === 409 ? "Tip changed" : "Unavailable");
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxPeerResponseBytes) throw new PeerError("Invalid response");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PeerError("Invalid response");
  }
}

async function fetchBlocks(url, tip, from, limit, signal) {
  const query = new URLSearchParams({ from, through: tip.height, anchor: tip.hash, limit });
  const blocks = await fetchJson(url + "/api/peer/blocks?" + query, signal);
  const expected = Math.min(limit, tip.height - from + 1);
  if (!Array.isArray(blocks) || blocks.length !== expected) {
    throw new PeerError("Invalid response");
  }
  return blocks;
}

async function findAncestor(chain, url, tip, signal) {
  async function matches(height) {
    const [block] = await fetchBlocks(url, tip, height, 1, signal);
    if (block?.height !== height || !isHash(block.hash)) throw new PeerError("Invalid response");
    return chain.hashAt(height) === block.hash;
  }

  let low = 0;
  let high = chain.tip.height;
  if (high === 0 || await matches(high)) return { height: high, hash: chain.hashAt(high) };
  high--;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (await matches(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { height: low, hash: chain.hashAt(low) };
}

async function* fetchBranch(url, tip, from, signal) {
  while (from <= tip.height) {
    const blocks = await fetchBlocks(url, tip, from, blockBatchSize, signal);
    yield blocks;
    from += blocks.length;
  }
}

export class PeerSync {
  #chain;
  #peers;
  #controller = new AbortController();
  #timer;
  #polling;

  constructor(chain, urls) {
    this.#chain = chain;
    this.#peers = urls.map((url) => ({ url, status: "Connecting" }));
  }

  start(localUrl) {
    this.#peers = this.#peers.filter(({ url }) => url !== localUrl);
    if (this.#peers.length) this.#poll();
  }

  #poll() {
    this.#polling = Promise.all(this.#peers.map((peer) => this.#sync(peer))).then(() => {
      if (!this.#controller.signal.aborted) this.#timer = setTimeout(() => this.#poll(), pollInterval);
    });
  }

  async #sync(peer) {
    const { url } = peer;
    const { signal } = this.#controller;
    try {
      const summary = await fetchJson(url + "/api/peer/tip", signal);
      const tip = summary?.tip;
      if (!isHeight(tip?.height) || !isHash(tip.hash) || !isHash(summary.genesis)) {
        throw new PeerError("Invalid response");
      }
      if (summary.genesis !== this.#chain.genesisHash) throw new PeerError("Different genesis");
      if (summary.rules !== peerRules) throw new PeerError("Incompatible rules");
      if (summary.block_subsidy !== this.#chain.blockSubsidy) throw new PeerError("Different block subsidy");
      if (tip.height === 0 && tip.hash !== summary.genesis) throw new PeerError("Invalid response");

      const local = this.#chain.tip;
      if (tip.height <= local.height) {
        peer.status = tip.hash === local.hash ? "Synced" :
          tip.height === local.height ? "Equal work fork" : "Peer behind";
        return;
      }

      peer.status = "Syncing";
      const ancestor = await findAncestor(this.#chain, url, tip, signal);
      const batches = fetchBranch(url, tip, ancestor.height + 1, signal);
      const adopted = await this.#chain.adoptBranch(ancestor, tip, batches);
      peer.status = adopted || this.#chain.tip.hash === tip.hash ? "Synced" : "Tip changed";
    } catch (error) {
      peer.status = error instanceof PeerError ? error.message : "Branch rejected";
    }
  }

  status() {
    return this.#peers;
  }

  async stop() {
    this.#controller.abort();
    clearTimeout(this.#timer);
    await this.#polling;
  }
}
