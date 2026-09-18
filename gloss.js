// Writes a one-line meaning for every word in data/words-30k.txt to data/glosses-30k.tsv.
// build-tree.js embeds "word: meaning" instead of the bare word, so the tree groups
// words by what they mean rather than by how they are spelled (single-word embeddings
// mostly encode letters: "claire, clark, clue, cliff" landed in one group).
// Runs once, with a cheap chat model through OpenRouter. Usage: node gloss.js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ensureKey } from './lib.js';

const MODEL = 'openai/gpt-4o-mini';
const BATCH = 200;
const PARALLEL = 8;

await ensureKey();
const file = (name) => new URL(`./data/${name}`, import.meta.url);
const words = readFileSync(file('words-30k.txt'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const out = file('glosses-30k.tsv');
const glosses = new Map(
  existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')) : [],
);
let cost = 0;

async function glossBatch(batch) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content:
            'For each word give a 5-10 word description of its meaning and part of speech, as lines `word<TAB>description` in the same order, no other text:\n' +
            batch.join('\n'),
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${MODEL} -> ${res.status}: ${json.error?.message ?? res.statusText}`);
  cost += json.usage?.cost ?? 0;
  for (const line of json.choices[0].message.content.split('\n')) {
    const m = line.match(/^(\S+?)(?:<TAB>|\t)\s*(.+?)\s*$/);
    if (m && batch.includes(m[1].toLowerCase())) glosses.set(m[1].toLowerCase(), m[2]);
  }
}

// Missing words are retried in smaller batches until every word has a gloss.
for (let size = BATCH; size >= 10; size = Math.floor(size / 4)) {
  const todo = words.filter((w) => !glosses.has(w));
  if (!todo.length) break;
  const batches = [];
  for (let i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size));
  for (let i = 0; i < batches.length; i += PARALLEL) {
    await Promise.all(batches.slice(i, i + PARALLEL).map((b) => glossBatch(b).catch((e) => console.error(`\n${e.message}`))));
    writeFileSync(out, words.filter((w) => glosses.has(w)).map((w) => `${w}\t${glosses.get(w)}`).join('\n') + '\n');
    process.stdout.write(`\rglossed ${glosses.size}/${words.length} ($${cost.toFixed(4)})`);
  }
}
console.log(`\ndone: ${glosses.size}/${words.length} words, $${cost.toFixed(4)}`);
