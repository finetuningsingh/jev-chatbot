# Jev as a chatbot

An experiment: can [TypeSafe's Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
act as a chatbot? Jev doesn't generate text. It answers `choice` questions
with a probability for each option. This project builds every reply out of
those choices, one letter or one word at a time, like a next-token predictor.

**Short answer: no.** Replies fall apart after a few words. Details are below.

## Run

Requires Node 18+ and an [OpenRouter key](https://openrouter.ai/keys) with Jev
access. There is nothing to install.

```sh
npm run chat           # scoring mode (best, ~10 s and ~$0.05 per reply)
npm run chat:fast      # letter-first mode (~3 s, ~$0.001 per reply)
npm run chat:letters   # letters mode
```

On the first run, the chat asks for your key. What you type is hidden. It is
saved to `.env`, which git ignores and which gets owner-only permissions
(`600`). The key is never printed or committed. To change the key, delete
`.env` and run again, or edit it. You can also copy `.env.example` to `.env`
yourself, or set `OPENROUTER_API_KEY` in your shell.

Type a message and press Enter to watch Jev build its reply. An empty line quits.

## How it works

- **Letters mode** (`replyByLetters`): each step asks Jev to choose one of the
  26 letters, `space`, or `end`. The state holds the conversation and the reply
  so far as a JSON string, so spaces stay visible.
- **Words mode** (`replyByWords`): each step asks Jev for the next word's first
  letter (26 letters, or `end`). Then it asks for the word itself from up to 250
  candidates starting with that letter. Candidates are words from the
  conversation first, then `data/words-10k.txt`. That takes two Jev calls per word.

- **Scoring mode** (`replyByScoring`, the default): every word in the
  dictionary competes at every step. Round 1 splits the ~9,900 words into
  groups of 250 (Jev's limit is 255 options per question). Jev picks within
  every group in parallel, using 3 requests of 15 groups each because of the
  ~32K-token request limit. Round 2 picks the next word from each group's top
  3, or ends the reply. That's 4 Jev calls per word.

The letter-first mode has two built-in problems. Jev has to know the word
before it can pick the right first letter, and a wrong letter rules out the
right word. Scoring mode removes both.

All modes always take the top choice, without sampling. Options that make no
sense are removed: a double space, ending an empty reply, and repeating the
previous word. A reply is cut off and marked
`[stopped: Jev started repeating itself]` when it falls into a cycle.

## Results (2026-09-18, `typesafe/jev-1.13`)

| Prompt | Letters mode | Words mode |
| --- | --- | --- |
| hi how are you | `hhhhhhhhh h hhhh…` | `hi how have had same the time` |
| who are you | `i a a a a…` | `i am a assistant` |
| what is the capital of france | `a c a a a aa…` | `capital is a city france in country called capital` |
| can you recommend a good book | `a a a a…` | `a and book recommend recommendation and answer ask` (loop) |
| tell me the meaning of life | — | `the to of top` |

Words mode takes about 2–6 s and costs under $0.001 per reply. Letters mode
takes about 30 s per reply when it runs to its 150-step limit.

### Scoring mode vs letter-first mode

| Prompt | Scoring (default) | Letter-first (`--fast`) |
| --- | --- | --- |
| hi what is capital of france | `hi paris is of france` | `hi hello answer actually capital france capital is paris` |
| hi how are you | `hi im good you are yourself how` | `hi how have had am thanks well` |
| who are you | `i am a assistant your for to help can and ai artificial intelligence` | `i am a assistant` |
| can you recommend a good book | `sure i can what you like about likes` (loop) | `a an` (loop) |
| tell me the meaning of life | `well depends is you for yourself the you yourself the` (loop) | `the to of top` |

Scoring mode starts replies much better ("sure i can", "well depends", "hi im
good"). It gets to "paris" right away, but it still falls apart after 4–6
words. It costs 8–18 s and $0.04–0.08 per reply, against 2–5 s and about $0.001.

## Limits

- **255 options per choice question.** A request with 256 options is
  rejected: `Too many choices. Must have at most 255 choices.`
- **About 32K tokens per request** (state plus all questions and options),
  found by testing. A request with 19 questions of 250 words each fit, and
  more did not. The longest state that fit was about 163,000 characters.

## Why it fails

Jev has some of the knowledge. For "what is the capital of France" it favoured
`p` after `"the capital of france is "`, and gave `end` a probability of 0.94
after `"paris"`. But each step is a separate, uncertain decision. After `par`,
`s` got 0.37 and `i` only 0.24. When the top choice is always taken, one wrong
step ruins every step after it.

That matches how TypeSafe describes Jev: it "gives up string generation" and
is built for fast, single, structured decisions. It is not built for long
chains of dependent choices. It does well at single next-letter guesses.
In a separate test on human-written sentences, it ranked the correct next
letter about 3rd of 26 on average, against about 8th for a fixed
letter-frequency order.

## Jev knows the answer but can't write it

The same question, asked two ways:

**As a chat reply** (words mode):

```
you: hi what is capital of france
jev: hi hello am are can do capital france answer actually answer  [stopped: Jev started repeating itself]
     [24 Jev calls, 6.5s, $0.0023]
```

**As one multiple-choice question:**

```js
import { jev } from './lib.js';

const r = await jev('hi what is capital of france', {
  answer: {
    type: 'choice',
    instructions: "What is the correct answer to the user's question?",
    criteria: { paris: 'Paris', lyon: 'Lyon', marseille: 'Marseille', berlin: 'Berlin', london: 'London' },
  },
});
// r.answers.answer.choice        -> 'paris'
// r.answers.answer.probabilities -> { paris: 1, lyon: 0, marseille: 0, berlin: 0, london: 0 }
// 1 call, 357 ms
```

Jev has the knowledge. As a single choice, it is correct and fully confident
in one call. As a chatbot, it has to make 24 dependent choices in a row. Each
step is a separate decision with no plan for the whole sentence, so the reply
becomes word salad:

- **Echoing:** words from the user's message are offered first, and Jev picks
  them back ("hi hello", "capital france").
- **No grammar:** each word is chosen alone, so the words don't join up
  ("am are can do").
- **Loops:** once off track, it cycles ("answer actually answer") until the
  loop check stops it.

**Takeaway:** use Jev where it is strong, for fast, calibrated single
decisions such as picking an answer, routing a request or flagging risk. Have
an LLM write the text. Jev is not a replacement for a text generator.

## Files

- `chatbot.js`: `replyByLetters` and `replyByWords`
- `chat.js`: interactive terminal chat
- `lib.js`: minimal Jev client for the OpenRouter decisions endpoint
- `data/words-10k.txt`: 10,000 common US English words from
  [first20hours/google-10000-english](https://github.com/first20hours/google-10000-english),
  derived from the Google Web Trillion Word Corpus. Its license permits
  educational, personal and research use.

## License

The code is released under the [MIT License](LICENSE). `data/words-10k.txt` is
not covered by it; it keeps the terms of its
[original source](https://github.com/first20hours/google-10000-english).
