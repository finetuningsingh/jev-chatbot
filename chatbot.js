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

const DICT = readFileSync(new URL('./data/words-10k.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((w) => w.trim().toLowerCase())
  .filter((w) => /^[a-z]+$/.test(w));

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

export async function replyByScoring(history, onStep = () => {}) {
  const groups = [];
  for (let i = 0; i < DICT.length; i += GROUP_SIZE) groups.push(DICT.slice(i, i + GROUP_SIZE));
  const words = [];
  let cost = 0, calls = 0, stuck = false;
  while (words.length < MAX_WORDS) {
    const state = chatState(history, words.join(' '));
    const instructions = `${ROLE} Your reply is written one word at a time; \`reply_so_far\` is what you have written. Which word should come next?`;

    const batches = [];
    for (let i = 0; i < groups.length; i += GROUPS_PER_REQUEST) batches.push(groups.slice(i, i + GROUPS_PER_REQUEST));
    const round1 = await Promise.all(
      batches.map((batch) =>
        jev(state, Object.fromEntries(batch.map((g, i) => [`g${i}`, { type: 'choice', instructions, criteria: Object.fromEntries(g.map((w) => [w, w])) }]))),
      ),
    );
    const finalists = new Set();
    for (const r of round1) {
      cost += r.cost, calls++;
      for (const a of Object.values(r.answers)) {
        Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, FINALISTS_PER_GROUP).forEach(([w]) => finalists.add(w));
      }
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
