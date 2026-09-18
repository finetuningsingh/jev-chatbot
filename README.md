# Jev as a chatbot

An experiment: can [TypeSafe's Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
act as a chatbot? Jev doesn't generate text. It answers `choice` questions
with a probability for each option. This project builds every reply out of
those choices, one letter or one word at a time, like a next-token predictor.

**Short answer: no.** Replies fall apart after a few words. Details are below.

## Run

Requires Node 18+ and an OpenRouter key with Jev access.

```sh
cp .env.example .env   # then add your OPENROUTER_API_KEY
npm run chat           # words mode
npm run chat:letters   # letters mode
```

Type a message and press Enter to watch Jev build its reply. An empty line quits.

## How it works

- **Letters mode** (`replyByLetters`): each step asks Jev to choose one of the
  26 letters, `space`, or `end`. The state holds the conversation and the reply
  so far as a JSON string, so spaces stay visible.
- **Words mode** (`replyByWords`): each step asks Jev for the next word's first
  letter (26 letters, or `end`). Then it asks for the word itself from up to 250
  candidates starting with that letter. Candidates are words from the
  conversation first, then `data/words-10k.txt`. That takes two Jev calls per word.

Both modes always take the top choice, without sampling. Options that make no
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

## Files

- `chatbot.js`: `replyByLetters` and `replyByWords`
- `chat.js`: interactive terminal chat
- `lib.js`: minimal Jev client for the OpenRouter decisions endpoint
- `data/words-10k.txt`: 10,000 common US English words from
  [first20hours/google-10000-english](https://github.com/first20hours/google-10000-english),
  derived from the Google Web Trillion Word Corpus. Its license permits
  educational, personal and research use.
