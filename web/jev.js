// Browser port of the word tree mode (see chatbot.js for the Node version).
// The page calls OpenRouter directly with the visitor's key; there is no server in between.
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';
const MAX_WORDS = 30;
const END = '__end';
const ROLE = 'You are a friendly, helpful chatbot replying to the last user message in `conversation`.';

export async function jev(key, state, questions, signal) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': location.origin, 'X-Title': 'Jev chatbot' },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('OpenRouter rejected the key (401). Check it and try again.');
  if (!res.ok || json.error) throw new Error(`Jev -> ${res.status}: ${json.error?.message ?? res.statusText}`);
  return { answers: json.answers, cost: json.usage?.cost ?? 0 };
}

const trees = {};
export async function loadTree(file) {
  if (!trees[file]) {
    const res = await fetch(new URL(`../data/${file}`, import.meta.url));
    if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
    trees[file] = await res.json();
  }
  return trees[file];
}

// True when the sequence ends with the same block of up to `maxLen` items repeated `times` times.
function looping(items, times, maxLen = 4) {
  for (let k = 1; k <= maxLen; k++) {
    if (items.length < k * times) continue;
    const block = items.slice(-k).join('\u0000');
    let same = true;
    for (let t = 2; t <= times && same; t++) same = items.slice(-k * t, -k * (t - 1)).join('\u0000') === block;
    if (same) return k;
  }
  return 0;
}

const chatState = (history, reply) => ({ conversation: history, reply_so_far: JSON.stringify(reply) });

// Word tree: pick 1 of 254 word groups (top `beam` kept), then the word with the best
// group x word probability. No repeated word pairs; ends when "reply complete" beats the best word.
export async function replyByTree(key, history, onStep = () => {}, { tree = 'tree-30k-wide.json', beam = 3, signal } = {}) {
  const root = await loadTree(tree);
  const words = [];
  let cost = 0, calls = 0, stuck = false;
  const groupPrompt = `${ROLE} Your reply is written one word at a time; \`reply_so_far\` is what you have written. Which group contains the best next word?`;
  const wordPrompt = `${ROLE} Your reply is written one word at a time; \`reply_so_far\` is what you have written. Which word comes next?`;
  while (words.length < MAX_WORDS) {
    const state = chatState(history, words.join(' '));
    let frontier = [{ node: root, p: 1 }];
    let pEnd = 0;
    while (frontier.some((f) => f.node.children)) {
      const questions = Object.fromEntries(
        frontier.filter((f) => f.node.children).map((f, i) => {
          const criteria = Object.fromEntries(f.node.children.map((c, j) => [`g${j}`, `Words like: ${c.label}`]));
          if (f.node === root && words.length) criteria[END] = 'No next word: the reply is complete';
          return [`q${i}`, { type: 'choice', instructions: groupPrompt, criteria }];
        }),
      );
      const r = await jev(key, state, questions, signal);
      cost += r.cost, calls++;
      const next = frontier.filter((f) => !f.node.children);
      frontier.filter((f) => f.node.children).forEach((f, i) => {
        for (const [k, p] of Object.entries(r.answers[`q${i}`].probabilities)) {
          if (k === END) pEnd = p;
          else next.push({ node: f.node.children[+k.slice(1)], p: f.p * p });
        }
      });
      frontier = next.sort((a, b) => b.p - a.p).slice(0, beam);
    }
    const banned = new Set([words.at(-1)]);
    for (let i = 0; i + 1 < words.length; i++) if (words[i] === words.at(-1)) banned.add(words[i + 1]);
    const leaves = frontier.map((f) => ({ ...f, options: (f.node.items ?? f.node.words).filter((w) => !banned.has(w)) })).filter((f) => f.options.length);
    const r = await jev(
      key,
      state,
      Object.fromEntries(leaves.map((f, i) => [`q${i}`, { type: 'choice', instructions: wordPrompt, criteria: Object.fromEntries(f.options.map((w) => [w, w])) }])),
      signal,
    );
    cost += r.cost, calls++;
    let best = { w: null, p: -1 };
    leaves.forEach((f, i) => {
      for (const [w, p] of Object.entries(r.answers[`q${i}`].probabilities)) if (f.p * p > best.p) best = { w, p: f.p * p };
    });
    if (pEnd > best.p) break;
    words.push(best.w);
    const k = looping(words, 2);
    if (k) {
      words.splice(-k);
      stuck = true;
      break;
    }
    onStep(words.join(' '));
  }
  return { reply: words.join(' '), cost, calls, stuck };
}
