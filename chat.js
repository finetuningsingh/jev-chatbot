// Chat with Jev: it replies by picking one letter (or word) at a time, shown live as it goes.
// Usage: node chat.js            (words mode: first letter, then the word)
//        node chat.js --letters  (pure mode: each step picks one of 26 letters, space, or end)
import { createInterface } from 'node:readline/promises';
import { replyByLetters, replyByWords } from './chatbot.js';

const letters = process.argv.includes('--letters');
const reply = letters ? replyByLetters : replyByWords;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const history = [];

console.log(`Chatting with Jev in ${letters ? 'letters' : 'words'} mode. Empty line or Ctrl+C to quit.\n`);
for (;;) {
  const text = (await rl.question('you: ').catch(() => '')).trim(); // input closed -> quit
  if (!text) break;
  history.push({ role: 'user', text });
  const t0 = performance.now();
  let shown = 0;
  process.stdout.write('jev: ');
  const r = await reply(history, (soFar) => {
    process.stdout.write(soFar.slice(shown));
    shown = soFar.length;
  });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (r.stuck) process.stdout.write('  [stopped: Jev started repeating itself]');
  console.log(`\n     [${r.calls} Jev calls, ${secs}s, $${r.cost.toFixed(4)}]\n`);
  history.push({ role: 'assistant', text: r.reply });
}
rl.close();
