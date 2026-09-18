import { readFileSync } from 'node:fs';

try {
  for (const line of readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

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
  if (!res.ok || json.error) throw new Error(`Jev -> ${res.status}: ${JSON.stringify(json.error ?? json)}`);
  return { answers: json.answers, cost: json.usage?.cost ?? 0, ms: Math.round(performance.now() - t0) };
}
