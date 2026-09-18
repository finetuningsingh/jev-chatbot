// Jev as a chatbot. Jev cannot generate text, so every reply is built from choices:
// - letters mode: each step picks one of 26 letters, space, or end.
// - words mode: each step picks a first letter (26 + end), then the whole word from
//   dictionary words starting with that letter (Jev choices are capped at 255 options).
import { readFileSync } from 'node:fs';
import { jev } from './lib.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const MAX_LETTER_STEPS = 150;
const MAX_WORDS = 30;
const MAX_WORD_OPTIONS = 250;

// Word lists, most frequent first: 10k from web text, 30k from movie/TV subtitles.
const VOCAB_FILES = { '10k': 'words-10k.txt', '30k': 'words-30k.txt' };
const vocabCache = {};
export function loadVocab(name = '10k') {
  return (vocabCache[name] ??= readFileSync(new URL(`./data/${VOCAB_FILES[name]}`, import.meta.url), 'utf8')
    .split('\n')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => /^[a-z]+$/.test(w)));
}
const DICT = loadVocab('10k');

// True when the sequence ends with the same block of up to `maxLen` items repeated `times` times,
// e.g. "answer answers answer answers". Greedy picking gets stuck in these cycles.
function looping(items, times, maxLen = 6) {
  for (let k = 1; k <= maxLen; k++) {
    if (items.length < k * times) continue;
    const block = items.slice(-k).join('\u0000');
    let same = true;
    for (let t = 2; t <= times && same; t++) same = items.slice(-k * t, -k * (t - 1)).join('\u0000') === block;
    if (same) return k;
  }
  return 0;
}

const ROLE = 'You are a friendly, helpful chatbot replying to the last user message in `conversation`.';

// Short, clean conversation state; the reply is JSON-quoted so spaces stay visible.
const chatState = (history, reply) => ({ conversation: history, reply_so_far: JSON.stringify(reply) });

export async function replyByLetters(history, onStep = () => {}) {
  const letters = Object.fromEntries(LETTERS.map((c) => [c, `The letter "${c}"`]));
  let reply = '', cost = 0, calls = 0, stuck = false;
  while (calls < MAX_LETTER_STEPS) {
    // Offer only moves that make sense: no space right after a space, no ending mid-nothing.
    const criteria = { ...letters };
    if (reply && !reply.endsWith(' ')) criteria.space = 'A space: the current word is finished';
    if (reply) criteria.end = 'The reply is finished';
    const r = await jev(chatState(history, reply), {
      next: {
        type: 'choice',
        instructions: `${ROLE} Your reply is spelled one character at a time; \`reply_so_far\` (a JSON string, spaces included) is what you have written. Which character comes next?`,
        criteria,
      },
    });
    cost += r.cost, calls++;
    const c = r.answers.next.choice;
    if (c === 'end') break;
    reply += c === 'space' ? ' ' : c;
    const k = looping([...reply], 3);
    if (k) {
      reply = reply.slice(0, -k * 2); // keep one copy of the repeated block
      stuck = true;
      break;
    }
    onStep(reply);
  }
  return { reply: reply.trim(), cost, calls, stuck };
}

// Candidate words for a first letter: words from the conversation first (names, topics),
// then general frequency.
function wordOptions(letter, history) {
  const seen = new Set();
  const out = [];
  const convo = history.flatMap((m) => m.text.toLowerCase().match(/[a-z]+/g) ?? []);
  for (const w of [...convo, ...DICT]) {
    if (w[0] === letter && !seen.has(w) && out.length < MAX_WORD_OPTIONS) seen.add(w), out.push(w);
  }
  return out;
}

export async function replyByWords(history, onStep = () => {}) {
  const letterCriteria = Object.fromEntries(LETTERS.map((c) => [c, `The next word starts with "${c}"`]));
  const words = [];
  let cost = 0, calls = 0, stuck = false;
  while (words.length < MAX_WORDS) {
    const state = chatState(history, words.join(' '));
    const first = await jev(state, {
      letter: {
        type: 'choice',
        instructions: `${ROLE} Your reply is written one word at a time; \`reply_so_far\` is what you have written. What letter does the next word start with?`,
        criteria: words.length ? { ...letterCriteria, end: 'The reply is finished' } : letterCriteria,
      },
    });
    cost += first.cost, calls++;
    const letter = first.answers.letter.choice;
    if (letter === 'end') break;
    // No immediate repeats: a greedy picker otherwise loops on one word.
    const options = wordOptions(letter, history).filter((w) => w !== words.at(-1));
    const pick = await jev(state, {
      word: {
        type: 'choice',
        instructions: `${ROLE} Your reply is written one word at a time; \`reply_so_far\` is what you have written. Which word comes next?`,
        criteria: Object.fromEntries(options.map((w) => [w, w])),
      },
    });
    cost += pick.cost, calls++;
    words.push(pick.answers.word.choice);
    const k = looping(words, 2, 4);
    if (k) {
      words.splice(-k); // keep one copy of the repeated block
      stuck = true;
      break;
    }
    onStep(words.join(' '));
  }
  return { reply: words.join(' '), cost, calls, stuck };
}

// Score-then-choose mode: every word in the dictionary competes at each step.
// Round 1 splits the dictionary into groups of up to 250 and Jev picks within every group
// in parallel (grouped into several requests, since one request holds ~32K tokens,
// about 19 groups). Round 2 picks the next word from each group's top candidates.
const GROUP_SIZE = 250;
const GROUPS_PER_REQUEST = 15; // headroom under the ~32K-token request limit for conversation state
const FINALISTS_PER_GROUP = 3;
const END = '__end';

export async function replyByScoring(history, onStep = () => {}, { vocab = '10k' } = {}) {
  const dict = loadVocab(vocab);
  const groups = [];
  for (let i = 0; i < dict.length; i += GROUP_SIZE) groups.push(dict.slice(i, i + GROUP_SIZE));
  const words = [];
  let cost = 0, calls = 0, stuck = false;
  while (words.length < MAX_WORDS) {
    const state = chatState(history, words.join(' '));
    const instructions = `${ROLE} Your reply is written one word at a time; \`reply_so_far\` is what you have written. Which word should come next?`;

    // Knockout rounds: Jev picks within every group of 250 in parallel and each group's top
    // words advance, until the survivors fit in one final choice (max 255 options).
    let candidates = groups;
    let finalists;
    for (;;) {
      const batches = [];
      for (let i = 0; i < candidates.length; i += GROUPS_PER_REQUEST) batches.push(candidates.slice(i, i + GROUPS_PER_REQUEST));
      const round = await Promise.all(
        batches.map((batch) =>
          jev(state, Object.fromEntries(batch.map((g, i) => [`g${i}`, { type: 'choice', instructions, criteria: Object.fromEntries(g.map((w) => [w, w])) }]))),
        ),
      );
      finalists = new Set();
      for (const r of round) {
        cost += r.cost, calls++;
        for (const a of Object.values(r.answers)) {
          Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, FINALISTS_PER_GROUP).forEach(([w]) => finalists.add(w));
        }
      }
      if (finalists.size <= 250) break;
      const next = [...finalists];
      candidates = [];
      for (let i = 0; i < next.length; i += GROUP_SIZE) candidates.push(next.slice(i, i + GROUP_SIZE));
    }
    finalists.delete(words.at(-1)); // no immediate repeats

    const criteria = Object.fromEntries([...finalists].map((w) => [w, w]));
    if (words.length) criteria[END] = 'Stop here: the reply is complete';
    const final = await jev(state, { word: { type: 'choice', instructions, criteria } });
    cost += final.cost, calls++;
    const pick = final.answers.word.choice;
    if (pick === END) break;
    words.push(pick);
    const k = looping(words, 2, 4);
    if (k) {
      words.splice(-k);
      stuck = true;
      break;
    }
    onStep(words.join(' '));
  }
  return { reply: words.join(' '), cost, calls, stuck };
}

// Tree modes: Jev walks a tree of groups built by meaning (see build-tree.js), from a
// broad group down to one item. Word trees give one word per walk; the reply tree gives
// a whole reply sentence taken from real assistant replies.
const treeCache = {};
const loadTree = (file) => (treeCache[file] ??= JSON.parse(readFileSync(new URL(`./data/${file}`, import.meta.url), 'utf8')));
const leafItems = (node) => node.items ?? node.words; // tree-30k.json predates the `items` key

// Walks from the root to a leaf group, one Jev choice per level. Returns null if Jev ends the reply.
async function walkTree(root, state, { groupPrompt, describe, allowEnd }) {
  let node = root, cost = 0, calls = 0;
  while (node.children) {
    const criteria = Object.fromEntries(node.children.map((c, i) => [`g${i}`, describe(c.label)]));
    if (node === root && allowEnd) criteria[END] = 'No next word: the reply is complete';
    const r = await jev(state, { group: { type: 'choice', instructions: groupPrompt, criteria } });
    cost += r.cost, calls++;
    if (r.answers.group.choice === END) return { node: null, cost, calls };
    node = node.children[+r.answers.group.choice.slice(1)];
  }
  return { node, cost, calls };
}

// Word tree: for every word, Jev first picks a group (out of up to 254, each described by
// its typical words), then a word inside it. Instead of committing to Jev's single top
// group, the walk keeps its `beam` most likely groups at every level (asked in one
// request), and the next word is the one with the highest group x word probability.
// Repeating a word pair already in the reply is banned, which is what greedy picking
// otherwise loops on ("and or and or").
export async function replyByTree(history, onStep = () => {}, { tree = 'tree-30k.json', beam = 3 } = {}) {
  const root = loadTree(tree);
  const words = [];
  let cost = 0, calls = 0, stuck = false;
  const groupPrompt = `${ROLE} Your reply is written one word at a time; \`reply_so_far\` is what you have written. Which group contains the best next word?`;
  const wordPrompt = `${ROLE} Your reply is written one word at a time; \`reply_so_far\` is what you have written. Which word comes next?`;
  while (words.length < MAX_WORDS) {
    const state = chatState(history, words.join(' '));
    // Frontier of (node, probability) pairs, widened level by level until all are leaves.
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
      const r = await jev(state, questions);
      cost += r.cost, calls++;
      const next = frontier.filter((f) => !f.node.children);
      frontier.filter((f) => f.node.children).forEach((f, i) => {
        const a = r.answers[`q${i}`];
        for (const [key, p] of Object.entries(a.probabilities)) {
          if (key === END) pEnd = p;
          else next.push({ node: f.node.children[+key.slice(1)], p: f.p * p });
        }
      });
      frontier = next.sort((a, b) => b.p - a.p).slice(0, beam);
    }

    // Banned: the last word again, and any word that repeats a pair already in the reply.
    const banned = new Set([words.at(-1)]);
    for (let i = 0; i + 1 < words.length; i++) if (words[i] === words.at(-1)) banned.add(words[i + 1]);
    const leaves = frontier.map((f) => ({ ...f, options: leafItems(f.node).filter((w) => !banned.has(w)) })).filter((f) => f.options.length);
    const r = await jev(
      state,
      Object.fromEntries(leaves.map((f, i) => [`q${i}`, { type: 'choice', instructions: wordPrompt, criteria: Object.fromEntries(f.options.map((w) => [w, w])) }])),
    );
    cost += r.cost, calls++;
    let best = { w: null, p: -1 };
    leaves.forEach((f, i) => {
      for (const [w, p] of Object.entries(r.answers[`q${i}`].probabilities)) if (f.p * p > best.p) best = { w, p: f.p * p };
    });
    // Ending is one leaf competing with every word: stop when it is likelier than the best word.
    if (pEnd > best.p) break;
    words.push(best.w);
    const k = looping(words, 2, 4);
    if (k) {
      words.splice(-k);
      stuck = true;
      break;
    }
    onStep(words.join(' '));
  }
  return { reply: words.join(' '), cost, calls, stuck };
}

// Reply-tree mode: one walk picks a topic, then a whole reply sentence from real
// assistant replies (OpenAssistant oasst1). Jev chooses the reply; it cannot compose one.
export async function replyByReplyTree(history, onStep = () => {}) {
  const root = loadTree('tree-replies.json');
  const state = { conversation: history };
  const walk = await walkTree(root, state, {
    groupPrompt: `${ROLE} Which group contains the best reply to the user's last message?`,
    describe: (label) => `Replies like: ${label}`,
    allowEnd: false,
  });
  const options = walk.node.items;
  const r = await jev(state, {
    reply: {
      type: 'choice',
      instructions: `${ROLE} Which of these is the best reply to the user's last message?`,
      criteria: Object.fromEntries(options.map((t, i) => [`r${i}`, t])),
    },
  });
  const reply = options[+r.answers.reply.choice.slice(1)];
  onStep(reply);
  return { reply, cost: walk.cost + r.cost, calls: walk.calls + 1, stuck: false };
}
