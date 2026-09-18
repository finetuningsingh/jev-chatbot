# Jev as a chatbot

An experiment: can [TypeSafe's Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
act as a chatbot? Jev doesn't generate text. It answers `choice` questions
with a probability for each option, and a question can have at most 255
options. This project turns Jev into a next-word predictor over 30,000 words
anyway: for every word of the reply, Jev picks 1 of 254 word groups, then the
word inside that group. It compares that with six other ways of building a
reply out of choices.

**Short answer:** as a word-by-word chatbot, Jev can manage short replies.
The word tree answers "hi what is capital of france" with `paris`, "who are
you" with `i am assistant` and "hi how are you" with `hi am good you`, at
about $0.003 and 2.6 s per reply. Longer replies fall apart into word salad.
That matches what Jev is built for: one fast, calibrated decision at a time,
not a chain of dependent ones. As a comparison, a **reply tree** where Jev
picks a whole existing reply instead of a word answers all five test prompts
in 0.6 s for $0.0008, but it can't say anything that isn't already in its list.

## Run

Requires Node 18+ and an [OpenRouter key](https://openrouter.ai/keys) with Jev
access. There is nothing to install.

```sh
npm run chat           # word tree: 1 of 254 word groups, then the word (~2.6 s, ~$0.003 per reply)
npm run chat:tree      # narrow word tree: 16 groups per level (~4 s, ~$0.002)
npm run chat:scoring   # scoring mode, 10k words: every word competes (~12 s, ~$0.05)
npm run chat:30k       # scoring mode, 30k words (~31 s, ~$0.36 per reply)
npm run chat:fast      # letter-first mode (~4 s, ~$0.001)
npm run chat:letters   # letters mode
npm run chat:replies   # reply tree: picks a whole real reply (~0.6 s, ~$0.0008)
npm run eval           # run every mode on the test prompts -> results/results.md
```

Type a message and press Enter to watch Jev build its reply. An empty line quits.

On the first run, the chat asks for your key. What you type is hidden. It is
saved to `.env`, which git ignores and which gets owner-only permissions
(`600`). The key is never printed or committed. To change the key, delete
`.env` and run again, or edit it. You can also copy `.env.example` to `.env`
yourself, or set `OPENROUTER_API_KEY` in your shell.

## The word tree

Jev takes at most 255 options per question, so it can't pick from 30,000 words
directly. The word tree splits the vocabulary into groups: 254 groups at the
top (255 minus one option for "the reply is complete"), and any group with
more than 250 words is split into up to 254 groups again. With 30,000 words
that gives 1,492 leaf groups, 1 to 2 levels deep. A third level would only be
needed with more than 254 × 254 ≈ 64,500 words.

For each word of the reply:

1. **Pick a group.** Jev sees each group as its 12 most common words ("Words
   like: hey, hello, hi, welcome, bye, goodbye…") and gets a probability for
   every group. The 3 most likely groups are kept, not just the top one.
2. **Pick the word.** One request asks Jev for the best word inside each of
   the 3 groups. The next word is the one with the highest group × word
   probability.
3. **Stop or continue.** "The reply is complete" is one option in the group
   question. When it is likelier than the best word, the reply ends.

Two rules stop the loops that greedy picking otherwise falls into ("and or and
or"): a word may not repeat the previous word, and may not repeat a pair of
words already in the reply. A reply that still cycles is cut off and marked
`[stopped: Jev started repeating itself]`.

### How the groups are made

The groups come from embeddings, built once by `build-tree.js`. Embedding bare
words groups them by spelling, not meaning: the first version put "claire,
clark, clue, cliff, clara" in one group and "know, key, keeps, kinds, kong" in
another. So `gloss.js` first writes a one-line meaning for every word with a
cheap chat model (`openai/gpt-4o-mini`, $0.28 for all 30,000 words, saved in
`data/glosses-30k.tsv`):

```
claire	French name meaning "clear" or "bright" (noun)
know	To be aware of or have information (verb)
burned	Past tense of burn; consumed by fire (verb)
```

Each word is then embedded as `word: meaning` with
`openai/text-embedding-3-small` ($0.007), and k-means splits the words into
groups, recursively, until each group has at most 250 words. Now the groups are
about meaning: "home, house, bed, hotel, apartment", "captain, army, lieutenant,
colonel, sergeant", "red, gold, silver, treasure, pink, diamond". The saved
trees are committed, so the chat only reads them.

| Tree | Built with | Shape |
| --- | --- | --- |
| `tree-30k-wide.json` | `node build-tree.js words-30k 254` | 254 top groups, 1,492 leaf groups, 1–2 levels |
| `tree-30k.json` | `node build-tree.js words-30k 16` | 16 top groups, 451 leaf groups, 2–3 levels |
| `tree-replies.json` | `node build-tree.js replies 254` | 254 groups of about 67 replies, 1 level |

## The seven modes

| Mode | How each word (or letter) is chosen | Jev calls per word |
| --- | --- | --- |
| **word tree** | Pick 1 of 254 word groups (top 3 kept), then the word, as described above. 30k words | 2–3 |
| **narrow tree** | Same walk over a tree with 16 groups per level: a broad group, narrower groups, then the word | 3–4 |
| **scoring** | Every word in the list competes: Jev picks within every group of 250 in parallel, the top 3 of each group advance, and a final choice picks the word | 4 (10k words) or about 9 (30k) |
| **letter-first** | Pick the first letter (26), then the word from up to 250 words starting with it | 2 |
| **letters** | Pick one of 26 letters, `space`, or `end` | 1 per letter |
| **reply tree** | Not word by word. Pick 1 of 254 topic groups of real assistant replies, then the whole reply sentence from that group | 2 per reply |

- **Word lists:** `data/words-10k.txt` holds the 10,000 most common words on
  the English web. `data/words-30k.txt` holds the 30,000 most common words in
  movie and TV subtitles, so closer to spoken English.
- **Replies:** `data/replies.txt` holds 17,063 reply openings (the first
  sentence, or two if the first is short) from English assistant messages in
  [OpenAssistant oasst1](https://huggingface.co/datasets/OpenAssistant/oasst1).
  Messages flagged as spam, toxic or containing personal information are left
  out, along with openings that only introduce a list, contain code or contain
  links. Jev sees a reply group as two typical replies ("Replies like: "The
  capital of Australia is Canberra." / "The current capital of France is
  Paris."").
- **All modes** always take the top choice, without sampling.

## Results (2026-09-18, `typesafe/jev-1.13`)

Generated by `npm run eval`. Full output: [`results/results.md`](results/results.md).

| Prompt | word tree (30k) | narrow tree (30k) | scoring (10k) | scoring (30k) | letter-first (10k) | letters | reply tree |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hi what is capital of france | `paris` | `hello is i im is paris` | `hi paris is of france` | `hi the is capital of france paris period` | `hi how with what am are can answer ask answer a answer ask` (loop) | `hi w i h` (loop) | `Paris is the capital of France.` |
| hi how are you | `hi am good you` | `good` | `hi i am good and how you are` | `hi im ood and how you are too` | `hi how have had thanks well how same how` | `hi h u e s s` | `Hi there! I'm doing well, how about you?` |
| who are you | `i am assistant` | `im am assistant` | `i am a assistant helpful to you` | `hi i am a assistant helpful to you and for need anything do can foryour whatyou nd d correcting sory wouid sorry you sorry im sorry you` (loop) | `i am a assistant` | `i a` (loop) | `Hello, I'm Open Assistant. Is there anything I can help you with?` |
| can you recommend a good book | `hi can you can could can book` | `sure best well best good book for to is i` | `sure depends what you like tell you what whats you like whats` (loop) | `sure depends what you like do you what like likes what like you sorry rewrite what wouid you like` (loop) | `a an` (loop) | `a` (loop) | `Certainly! I recommend "Dark Matter" by Blake Crouch.` |
| tell me the meaning of life | `well so well` | `i life` | `well depends on you is yourself` | `well depends on you your own upto yourself is decide foryour the correcting sorry the sorry orry sorry anyway anyhow actually is varies subjective it` | `the to of top` | `ab s` (loop) | `The meaning of life is a philosophical question that has been debated throughout history, and there is no single answer that is universally accepted.` |

### Cost and time per reply

| Mode | Jev calls | Avg time | Avg cost | Total for 5 prompts |
| --- | --- | --- | --- | --- |
| word tree (30k) | 9 | 2.6 s | $0.0032 | $0.0162 |
| narrow tree (30k) | 17 | 4.0 s | $0.0024 | $0.0120 |
| scoring (10k) | 35 | 11.6 s | $0.0521 | $0.2603 |
| scoring (30k) | 188 | 30.7 s | $0.3553 | $1.7767 |
| letter-first (10k) | 15 | 4.0 s | $0.0014 | $0.0069 |
| letters | 9 | 2.5 s | $0.0003 | $0.0016 |
| reply tree | 2 | 0.6 s | $0.0008 | $0.0039 |

The full comparison (35 replies) cost **$2.08** in Jev calls. $1.78 of that
was scoring (30k). Building the trees cost $0.28 for the glosses and $0.015
for embeddings, once.

What the numbers say:

- **The word tree is the best word-by-word mode.** Short replies come out
  right (`paris`, `i am assistant`, `hi am good you`), nothing loops, and it
  costs $0.003 per reply: 16 times cheaper and 4 times faster than scoring.
  Open questions ("recommend a book", "the meaning of life") still give word
  salad. It has no plan for the sentence, only the next word.
- **Groups by meaning matter.** With groups by spelling, the same tree looped
  within 3 words on 4 of 5 prompts (`fine and or`, `i im am is ist`).
- **Wide beats narrow.** 254 groups per level gets to the word in 2–3 calls;
  16 per level needs 3–4 and gives Jev vaguer groups to choose from.
- **Scoring (10k) writes longer openings** ("hi paris is of france", "well
  depends on you is yourself") at 16 times the price, and then loops.
- **30k words are worse than 10k for scoring.** Replies pick up subtitle
  misspellings ("wouid", "ood").
- **Letters mode loops almost immediately.**
- **The reply tree is the cheapest and reads best**, because it doesn't build
  anything: it picks 1 of 17,063 existing replies. See its limits below.

### The reply tree's limits

Jev can only choose from the 17,063 stored replies. Questions without a
fitting reply show the limit:

| Prompt | Reply tree |
| --- | --- |
| what is 17 times 23 | `Sure! I can help with that.` |
| my name is ankit, what is my name? | `Hello! How can I help you?` |
| how do i boil an egg | `To answer your question, I need more information. What is the recipe you are using?` |
| tell me a joke | `As much wood as a woodchuck could chuck, If a woodchuck could chuck wood.` |

It can't do arithmetic, use facts from the conversation or explain a new
procedure. The five test prompts are common chatbot questions, so they suit it
well.

## Jev knows the answer but can't write it

The same question, asked two ways:

**As a chat reply** (letter-first mode, from a live chat):

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
in one call. As a chatbot, it has to make dozens of dependent choices in a
row. Each is a separate decision with no plan for the whole sentence, so a
reply that needs more than a few words becomes word salad:

- **Echoing:** it repeats the user's words ("hi hello", "capital france").
- **No grammar:** each word is chosen alone, so the words don't join up
  ("am are can do").
- **Loops:** once off track, it cycles ("answer actually answer") until the
  loop check stops it.

Letter by letter it is the same story. Jev favoured `p` after
`"the capital of france is "`, and gave `end` a probability of 0.94 after
`"paris"`. But mid-word it was unsure: after `par`, `s` got 0.37 and `i` only
0.24. One wrong step ruins every step after it.

**Takeaway:** that matches how TypeSafe describes Jev: it "gives up string
generation" and is built for fast, calibrated single decisions. The word tree
gets the most out of that by making each word two clean decisions (which
group, which word) and by not letting the same mistake repeat. Use Jev to
pick answers, route requests or flag risk, and have an LLM write any text that
doesn't exist yet.

## Limits

- **255 options per choice question.** A request with 256 options is
  rejected: `Too many choices. Must have at most 255 choices.`
- **About 32K tokens per request** (state plus all questions and options),
  found by testing. A request with 19 questions of 250 words each fit, and
  more did not. The longest state that fit was about 163,000 characters.

## Files

- `chatbot.js`: the reply modes (`replyByTree`, `replyByScoring`,
  `replyByWords`, `replyByLetters`, `replyByReplyTree`)
- `chat.js`: interactive terminal chat
- `eval.js`: runs every mode on the test prompts and writes `results/`
- `gloss.js`: writes a one-line meaning for every word to `data/glosses-30k.tsv`
- `build-tree.js`: builds the trees in `data/` from embeddings (cached in the
  git-ignored `data/.cache/`)
- `lib.js`: minimal Jev client for the OpenRouter decisions endpoint
- `data/words-10k.txt`: from
  [first20hours/google-10000-english](https://github.com/first20hours/google-10000-english),
  derived from the Google Web Trillion Word Corpus. Its license permits
  educational, personal and research use.
- `data/words-30k.txt`: top 30,000 lowercase words from
  [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords)
  (`content/2018/en/en_50k.txt`, built from OpenSubtitles), with a small list
  of profanities removed. Licensed
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- `data/glosses-30k.tsv`, `data/tree-30k.json`, `data/tree-30k-wide.json`:
  meanings and word groups derived from `words-30k.txt`, so also CC BY-SA 4.0.
- `data/replies.txt`, `data/tree-replies.json`: reply openings from
  [OpenAssistant oasst1](https://huggingface.co/datasets/OpenAssistant/oasst1)
  (`2023-04-12_oasst_ready.messages.jsonl.gz`), trimmed and filtered as
  described above. Licensed
  [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0).

## License

The code is released under the [MIT License](LICENSE). The files in `data/`
are not covered by it. They keep the terms of their sources, listed above.
