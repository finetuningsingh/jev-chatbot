// Builds a tree of groups by meaning, which Jev walks down to pick a word or a reply.
// Every item gets an embedding (words as "word: meaning", see gloss.js), then k-means
// splits the items into BRANCHES groups, recursively, until each group has at most
// LEAF_MAX items (one Jev choice). Runs once; the tree is saved to data/ and the chat
// only reads it.
//
// Usage:
//   node build-tree.js words-30k 254   -> data/tree-30k-wide.json  (word tree, the default chat mode)
//   node build-tree.js words-30k 16    -> data/tree-30k.json       (narrow word tree)
//   node build-tree.js replies 254     -> data/tree-replies.json   (reply tree mode)
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { ensureKey } from './lib.js';

const SOURCES = {
  'words-30k': { file: 'words-30k.txt', out: (b) => (b === 16 ? 'tree-30k.json' : 'tree-30k-wide.json'), kind: 'words' },
  replies: { file: 'replies.txt', out: () => 'tree-replies.json', kind: 'sentences' },
};
const source = SOURCES[process.argv[2] ?? 'words-30k'];
const BRANCHES = Number(process.argv[3] ?? 16);
const LEAF_MAX = 250;
if (!source || !(BRANCHES >= 2 && BRANCHES <= 254)) {
  console.error('Usage: node build-tree.js <words-30k|replies> <branches 2-254>');
  process.exit(1);
}

await ensureKey();
const dataFile = (name) => new URL(`./data/${name}`, import.meta.url);
const items = readFileSync(dataFile(source.file), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

// Words are embedded as "word: meaning" (see gloss.js) when glosses exist, so groups form
// by meaning; the bare word's embedding mostly encodes spelling.
const glossFile = source.kind === 'words' && dataFile('glosses-30k.tsv');
const glosses = new Map(glossFile && existsSync(glossFile) ? readFileSync(glossFile, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')) : []);
const texts = items.map((w) => (glosses.has(w) ? `${w}: ${glosses.get(w)}` : w));
if (glossFile) console.log(`${glosses.size} of ${items.length} words have glosses`);

// Embeddings are cached (git-ignored) so rebuilding with other settings costs nothing.
const DIM = 1536;
const cacheDir = new URL('./data/.cache/', import.meta.url);
const cacheFile = new URL(`embeddings-${source.file}${glosses.size ? '-glossed' : ''}.bin`, cacheDir);
let flat;
if (existsSync(cacheFile)) {
  flat = new Float32Array(readFileSync(cacheFile).buffer.slice(0));
  console.log(`using cached embeddings for ${items.length} items`);
} else {
  flat = new Float32Array(items.length * DIM);
  let cost = 0;
  for (let i = 0; i < items.length; i += 1000) {
    const batch = texts.slice(i, i + 1000);
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: batch }),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`embeddings -> ${res.status}: ${json.error?.message ?? res.statusText}`);
    cost += json.usage?.cost ?? 0;
    json.data.forEach((d, j) => {
      const n = Math.hypot(...d.embedding);
      flat.set(d.embedding.map((x) => x / n), (i + j) * DIM);
    });
    process.stdout.write(`\rembedded ${Math.min(i + 1000, items.length)}/${items.length} ($${cost.toFixed(5)})`);
  }
  console.log();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, Buffer.from(flat.buffer));
}
const vec = (i) => flat.subarray(i * DIM, (i + 1) * DIM);
const dot = (a, b) => {
  let s = 0;
  for (let d = 0; d < DIM; d++) s += a[d] * b[d];
  return s;
};

// Cosine k-means on item indices, with k-means++ seeding.
function kmeans(ids, k) {
  const centers = [vec(ids[Math.floor(Math.random() * ids.length)])];
  const best = new Float64Array(ids.length).fill(-1);
  while (centers.length < k) {
    const c = centers.at(-1);
    let total = 0;
    ids.forEach((id, i) => {
      best[i] = Math.max(best[i], dot(vec(id), c));
      total += 1 - best[i];
    });
    let r = Math.random() * total, i = 0;
    while ((r -= 1 - best[i]) > 0 && i < ids.length - 1) i++;
    centers.push(Float32Array.from(vec(ids[i])));
  }
  let assign = new Int32Array(ids.length);
  for (let iter = 0; iter < 10; iter++) {
    ids.forEach((id, i) => {
      const v = vec(id);
      let bj = 0, bs = -Infinity;
      for (let j = 0; j < k; j++) {
        const s = dot(v, centers[j]);
        if (s > bs) (bs = s), (bj = j);
      }
      assign[i] = bj;
    });
    const sums = Array.from({ length: k }, () => new Float32Array(DIM));
    ids.forEach((id, i) => {
      const v = vec(id), s = sums[assign[i]];
      for (let d = 0; d < DIM; d++) s[d] += v[d];
    });
    sums.forEach((s, j) => {
      const n = Math.hypot(...s);
      if (n > 0) centers[j] = s.map((x) => x / n);
    });
  }
  return { groups: Array.from({ length: k }, (_, j) => ids.filter((_, i) => assign[i] === j)).filter((g) => g.length) };
}

// How Jev sees a group: for words, its most frequent words; for replies, the two shortest
// of the replies closest to the group's centre.
function label(ids) {
  if (source.kind === 'words') return [...ids].sort((a, b) => a - b).slice(0, 12).map((i) => items[i]).join(', ');
  const c = new Float32Array(DIM);
  for (const id of ids) {
    const v = vec(id);
    for (let d = 0; d < DIM; d++) c[d] += v[d];
  }
  const typical = [...ids].sort((a, b) => dot(vec(b), c) - dot(vec(a), c)).slice(0, 6);
  return typical.sort((a, b) => items[a].length - items[b].length).slice(0, 2).map((i) => `"${items[i].slice(0, 90)}"`).join(' / ');
}

function build(ids, isRoot = true) {
  const node = { label: label(ids) };
  if (ids.length <= LEAF_MAX) return { ...node, items: [...ids].sort((a, b) => a - b).map((i) => items[i]) };
  // The root always splits into BRANCHES groups. A group that is still too big is split
  // into just enough subgroups of ~125 words, not into BRANCHES tiny ones.
  const k = isRoot ? BRANCHES : Math.min(BRANCHES, Math.max(2, Math.ceil(ids.length / 125)));
  let { groups } = kmeans(ids, k);
  // A degenerate split (one group holding nearly everything) falls back to even chunks.
  if (Math.max(...groups.map((g) => g.length)) > ids.length * 0.9) {
    const size = Math.ceil(ids.length / BRANCHES);
    groups = [];
    for (let i = 0; i < ids.length; i += size) groups.push(ids.slice(i, i + size));
  }
  return { ...node, size: ids.length, children: groups.map((g) => build(g, false)) };
}

const t0 = performance.now();
const tree = build(items.map((_, i) => i));
const leaves = [];
const walk = (n, depth) => (n.items ? leaves.push(depth) : n.children.forEach((c) => walk(c, depth + 1)));
walk(tree, 0);
const out = source.out(BRANCHES);
writeFileSync(dataFile(out), JSON.stringify(tree));
console.log(
  `${out}: ${tree.children.length} top groups, ${leaves.length} leaf groups, depth ${Math.min(...leaves)}-${Math.max(...leaves)}, ` +
    `built in ${((performance.now() - t0) / 1000).toFixed(0)}s`,
);
