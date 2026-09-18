// Chat with Jev: it replies by picking one letter (or word) at a time, shown live as it goes.
// Usage: node chat.js            (scoring mode: every word competes, then a final pick)
//        node chat.js --30k      (scoring mode with the 30k subtitle word list)
//        node chat.js --replies  (reply tree: topic group, then a whole real reply sentence)
//        node chat.js --wide     (wide word tree: 1 of 254 word groups, then the word)
//        node chat.js --tree     (tree mode: broad word group, narrower group, then the word)
//        node chat.js --fast     (letter-first mode: first letter, then the word)
//        node chat.js --letters  (pure mode: each step picks one of 26 letters, space, or end)
import { createInterface } from 'node:readline/promises';
import { replyByLetters, replyByWords, replyByScoring, replyByTree, replyByReplyTree } from './chatbot.js';
import { ensureKey } from './lib.js';

await ensureKey();

const flag = (f) => process.argv.includes(f);
const mode = flag('--letters') ? 'letters' : flag('--fast') ? 'letter-first' : flag('--tree') ? 'tree'
  : flag('--wide') ? 'wide-tree' : flag('--replies') ? 'reply-tree' : flag('--30k') ? 'scoring-30k' : 'scoring';
const reply = {
  letters: replyByLetters,
  'letter-first': replyByWords,
  tree: (h, onStep) => replyByTree(h, onStep, { tree: 'tree-30k.json' }),
  'wide-tree': (h, onStep) => replyByTree(h, onStep, { tree: 'tree-30k-wide.json' }),
  'reply-tree': replyByReplyTree,
  scoring: (h, onStep) => replyByScoring(h, onStep, { vocab: '10k' }),
  'scoring-30k': (h, onStep) => replyByScoring(h, onStep, { vocab: '30k' }),
}[mode];
const rl = createInterface({ input: process.stdin, output: process.stdout });
const history = [];

console.log(`Chatting with Jev in ${mode} mode. Empty line or Ctrl+C to quit.\n`);
for (;;) {
  const text = (await rl.question('you: ').catch(() => '')).trim(); // input closed -> quit
  if (!text) break;
  history.push({ role: 'user', text });
  const t0 = performance.now();
  let shown = 0;
  process.stdout.write('jev: ');
  let r;
  try {
    r = await reply(history, (soFar) => {
      process.stdout.write(soFar.slice(shown));
      shown = soFar.length;
    });
  } catch (e) {
    console.log(`\n     [error: ${e.message}]\n`);
    history.pop();
    continue;
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (r.stuck) process.stdout.write('  [stopped: Jev started repeating itself]');
  console.log(`\n     [${r.calls} Jev calls, ${secs}s, $${r.cost.toFixed(4)}]\n`);
  history.push({ role: 'assistant', text: r.reply });
}
rl.close();
