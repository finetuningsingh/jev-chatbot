// Builds data/tree-<vocab>.json: a tree of word groups by meaning, for the tree mode.
// Every word gets an embedding, then k-means splits the list into BRANCHES groups,
// recursively, until each group has at most LEAF_MAX words (one Jev choice).
// Usage: node build-tree.js [10k|30k]   (costs about $0.001 in embeddings)
import { writeFileSync } from 'node:fs';
import { ensureKey } from './lib.js';
import { loadVocab } from './chatbot.js';

const BRANCHES = 16;
const LEAF_MAX = 250;
const LABEL_WORDS = 12; // most frequent words shown to Jev as a group's description
const vocab = process.argv[2] ?? '30k';

await ensureKey();
const words = loadVocab(vocab);
const rank = new Map(words.map((w, i) => [w, i]));

async function embed(batch) {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: batch }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`embeddings -> ${res.status}: ${json.error?.message ?? res.statusText}`);
  return { vectors: json.data.map((d) => d.embedding), cost: json.usage?.cost ?? 0 };
}

let cost = 0;
const vec = new Map();
for (let i = 0; i < words.length; i += 2000) {
  const batch = words.slice(i, i + 2000);
  const r = await embed(batch);
  cost += r.cost;
  batch.forEach((w, j) => {
    const v = Float32Array.from(r.vectors[j]);
    const n = Math.hypot(...v);
    vec.set(w, v.map((x) => x / n));
  });
  process.stdout.write(`\rembedded ${Math.min(i + 2000, words.length)}/${words.length}`);
}
console.log();

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// Cosine k-means with k-means++ seeding.
function kmeans(items, k) {
  const pts = items.map((w) => vec.get(w));
  const centers = [pts[Math.floor(Math.random() * pts.length)]];
  while (centers.length < k) {
    const d = pts.map((p) => 1 - Math.max(...centers.map((c) => dot(p, c))));
    let r = Math.random() * d.reduce((a, b) => a + b, 0);
    let i = 0;
    while ((r -= d[i]) > 0 && i < d.length - 1) i++;
    centers.push(pts[i]);
  }
  let assign = [];
  for (let iter = 0; iter < 15; iter++) {
    assign = pts.map((p) => {
      let best = 0, bs = -Infinity;
      centers.forEach((c, j) => {
        const s = dot(p, c);
        if (s > bs) (bs = s), (best = j);
      });
      return best;
    });
    for (let j = 0; j < k; j++) {
      const members = pts.filter((_, i) => assign[i] === j);
      if (!members.length) continue;
      const c = new Float32Array(members[0].length);
      for (const m of members) for (let d = 0; d < c.length; d++) c[d] += m[d];
      const n = Math.hypot(...c);
      centers[j] = c.map((x) => x / n);
    }
  }
  return Array.from({ length: k }, (_, j) => items.filter((_, i) => assign[i] === j)).filter((g) => g.length);
}

const byFrequency = (list) => [...list].sort((a, b) => rank.get(a) - rank.get(b));

function build(items) {
  items = byFrequency(items);
  const label = items.slice(0, LABEL_WORDS).join(', ');
  if (items.length <= LEAF_MAX) return { label, words: items };
  let groups = kmeans(items, BRANCHES);
  // A degenerate split (one group holding nearly everything) falls back to frequency chunks.
  if (Math.max(...groups.map((g) => g.length)) > items.length * 0.9) {
    groups = [];
    for (let i = 0; i < items.length; i += Math.ceil(items.length / BRANCHES)) groups.push(items.slice(i, i + Math.ceil(items.length / BRANCHES)));
  }
  return { label, size: items.length, children: groups.map(build) };
}

const tree = build(words);
const leaves = [];
const walk = (n, depth) => (n.words ? leaves.push(depth) : n.children.forEach((c) => walk(c, depth + 1)));
walk(tree, 0);
writeFileSync(new URL(`./data/tree-${vocab}.json`, import.meta.url), JSON.stringify(tree));
console.log(`tree-${vocab}.json: ${leaves.length} leaf groups, depth ${Math.min(...leaves)}-${Math.max(...leaves)}, embeddings cost $${cost.toFixed(5)}`);
