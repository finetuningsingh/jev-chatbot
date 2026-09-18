import { readFileSync, writeFileSync } from 'node:fs';

const ENV_FILE = new URL('.env', import.meta.url);

try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

// Read a line from the terminal without echoing it, so a pasted key never shows on screen.
function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') process.exit(130); // Ctrl+C
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

// On first run, ask for the OpenRouter key and save it to .env (git-ignored, owner-only permissions).
export async function ensureKey() {
  if (process.env.OPENROUTER_API_KEY) return;
  if (!process.stdin.isTTY) {
    console.error('Missing OPENROUTER_API_KEY. Copy .env.example to .env and add your key.');
    process.exit(1);
  }
  console.log('No OpenRouter key found. Get one at https://openrouter.ai/keys');
  const key = await readHidden('Paste your OpenRouter API key (hidden): ');
  if (!key) process.exit(1);
  writeFileSync(ENV_FILE, `OPENROUTER_API_KEY=${key}\n`, { mode: 0o600 });
  process.env.OPENROUTER_API_KEY = key;
  console.log('Saved to .env (git-ignored, readable only by you).\n');
}

const JEV_MODEL = process.env.JEV_MODEL ?? 'typesafe/jev-1.13';

// Jev on OpenRouter uses the decisions endpoint, not chat/completions.
export async function jev(state, questions) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Missing OPENROUTER_API_KEY (set it in .env)');
  const t0 = performance.now();
  const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
  });
  const json = await res.json();
  if (res.status === 401) throw new Error('OpenRouter rejected the key (401). Fix or delete .env and run again.');
  if (!res.ok || json.error) throw new Error(`Jev -> ${res.status}: ${json.error?.message ?? JSON.stringify(json.error ?? json)}`);
  return { answers: json.answers, cost: json.usage?.cost ?? 0, ms: Math.round(performance.now() - t0) };
}
