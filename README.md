# Jev as a chatbot

An experiment: can [TypeSafe's Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
act as a chatbot? Jev doesn't generate text. It answers `choice` questions
with a probability for each option. This project builds every reply out of
those choices, one letter or one word at a time, like a next-token predictor.
It compares seven ways of doing that.

**Short answer:** Jev can't write a reply, but it can *pick* one very well.
Every mode that builds a reply word by word falls apart after a few words.
The **reply tree** does something different. Jev walks a tree of 17,063 real
assistant replies, choosing a topic and then a whole reply sentence, and
answers all five test prompts correctly ("Paris is the capital of France.")
in 0.6 s for under $0.001. The limit is that it can only choose from replies
that already exist; it cannot compute, remember or say anything new.

## Run

Requires Node 18+ and an [OpenRouter key](https://openrouter.ai/keys) with Jev
access. There is nothing to install.

```sh
npm run chat           # reply tree: picks a whole real reply (~0.6 s, ~$0.0008 per reply)
npm run chat:scoring   # scoring mode, 10k words (best word-by-word mode, ~12 s, ~$0.05)
npm run chat:wide      # wide word tree, 30k words (~2.6 s, ~$0.003)
npm run chat:30k       # scoring mode, 30k words (~31 s, ~$0.36 per reply)
npm run chat:tree      # tree mode, 30k words (~10 s, ~$0.002 per reply)
npm run chat:fast      # letter-first mode (~4 s and ~$0.001 per reply)
npm run chat:letters   # letters mode
npm run eval           # run every mode on the test prompts -> results/results.md
```

Type a message and press Enter to watch Jev build its reply. An empty line quits.

On the first run, the chat asks for your key. What you type is hidden. It is
saved to `.env`, which git ignores and which gets owner-only permissions
(`600`). The key is never printed or committed. To change the key, delete
`.env` and run again, or edit it. You can also copy `.env.example` to `.env`
yourself, or set `OPENROUTER_API_KEY` in your shell.

## The seven modes

| Mode | How each word (or letter) is chosen | Jev calls per word |
| --- | --- | --- |
| **letters** | Pick one of 26 letters, `space`, or `end` | 1 per letter |
| **letter-first** | Pick the first letter (26), then the word from up to 250 words starting with it | 2 |
| **tree** | Walk a tree of word groups built by meaning: a broad group (e.g. *people*, *places*, *food*, *feelings*), then narrower groups, then the word | about 3–4 |
| **wide tree** | Same, but 254 groups per level (Jev's maximum, minus one option for "end"): pick 1 of 254 groups, then the word. A few large groups split once more | 2–3 |
| **scoring** | Every word in the list competes: Jev picks within every group of 250 in parallel, the top 3 of each group advance, and a final choice picks the word | 4 (10k words) or about 9 (30k) |
| **reply tree** | Not word by word. Pick 1 of 254 topic groups of real assistant replies, then the whole reply sentence from that group | 2 per reply |

- **Word lists:** `data/words-10k.txt` holds the 10,000 most common words on
  the English web. `data/words-30k.txt` holds the 30,000 most common words in
  movie and TV subtitles, so closer to spoken English.
- **Replies:** `data/replies.txt` holds 17,063 reply openings (the first
  sentence, or two if the first is short) from English assistant messages in
  [OpenAssistant oasst1](https://huggingface.co/datasets/OpenAssistant/oasst1).
  Messages flagged as spam, toxic or containing personal information are left
  out, along with openings that only introduce a list, contain code or contain
  links.
- **The trees** are built once by `build-tree.js`. It embeds every item with
  `openai/text-embedding-3-small`, then k-means splits the items into N
  groups, recursively, until each group has at most 250 items. The saved trees
  are committed, so the chat only reads them. Embeddings cost $0.0012 for the
  30k words and $0.0084 for the replies.

  | Tree | Built with | Shape |
  | --- | --- | --- |
  | `tree-30k.json` | `node build-tree.js words-30k 16` | 331 leaf groups, 2–3 levels |
  | `tree-30k-wide.json` | `node build-tree.js words-30k 254` | 254 top groups, 954 leaf groups, 1–2 levels |
  | `tree-replies.json` | `node build-tree.js replies 254` | 254 groups of about 67 replies, 1 level |

  Jev sees a word group as its 12 most common words ("Words like: girl,
  mother, woman, mom…"). It sees a reply group as two typical replies
  ("Replies like: "The capital of Australia is Canberra." / "The current
  capital of France is Paris."").

  A tree with 254 groups per level runs out of items quickly: 2 levels give
  254 × 254 ≈ 64,500 slots, more than there are words or replies here. So the
  wide trees are 1–2 levels deep, and a third level would need more than
  64,500 items.
- **All modes** always take the top choice, without sampling. Options that make
  no sense are removed: a double space, ending an empty reply, and repeating
  the previous word. A reply is cut off and marked
  `[stopped: Jev started repeating itself]` when it falls into a cycle.

## Results (2026-09-18, `typesafe/jev-1.13`)

Generated by `npm run eval`. Full output: [`results/results.md`](results/results.md).

| Prompt | letters | letter-first (10k) | tree (30k) | wide tree (30k) | scoring (10k) | scoring (30k) | reply tree |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hi what is capital of france | `hi w i h` (loop) | `hi how with what am are can answer ask answer a answer ask` (loop) | `hi hello the is the what that the how is the paris is the` (loop) | `paris` | `hi paris is of france` | `hi the is capital of france paris period` | `Paris is the capital of France.` |
| hi how are you | `hi h u e s s` | `hi how have had thanks well how same how` | `hi well good and you` | `fine and or` (loop) | `hi i am good and how you are` | `hi im ood and how you are too` | `Hi there! I'm doing well, how about you?` |
| who are you | `i a` (loop) | `i am a assistant` | `i im am just ai be are well and how` (loop) | `i im am is ist` (loop) | `i am a assistant helpful to you` | `hi i am a assistant helpful to you and for need anything do can foryour whatyou nd d correcting sory wouid sorry you sorry im sorry you` (loop) | `Hello, I'm Open Assistant. Is there anything I can help you with?` |
| can you recommend a good book | `a` (loop) | `a an` (loop) | `sure what you like about in about bout in that about` (loop) | `sure what which` (loop) | `sure depends what you like tell you what whats you like whats` (loop) | `sure depends what you like do you what like likes what like you sorry rewrite what wouid you like` (loop) | `Certainly! I recommend "Dark Matter" by Blake Crouch.` |
| tell me the meaning of life | `ab s` (loop) | `the to of top` | `the is has what that` (loop) | `well hmm hmmm` (loop) | `well depends on you is yourself` | `well depends on you your own upto yourself is decide foryour the correcting sorry the sorry orry sorry anyway anyhow actually is varies subjective it` | `The meaning of life is a philosophical question that has been debated throughout history, and there is no single answer that is universally accepted.` |

### Cost and time per reply

| Mode | Jev calls | Avg time | Avg cost | Total for 5 prompts |
| --- | --- | --- | --- | --- |
| letters | 9 | 2.5 s | $0.0003 | $0.0016 |
| letter-first (10k) | 15 | 4.0 s | $0.0014 | $0.0069 |
| tree (30k) | 40 | 10.3 s | $0.0018 | $0.0090 |
| wide tree (30k) | 9 | 2.6 s | $0.0027 | $0.0136 |
| scoring (10k) | 35 | 11.6 s | $0.0521 | $0.2603 |
| scoring (30k) | 188 | 30.7 s | $0.3553 | $1.7767 |
| reply tree | 2 | 0.6 s | $0.0008 | $0.0039 |

The full comparison (35 replies) cost **$2.07** in Jev calls. $1.78 of that
was scoring (30k). Building the three trees cost $0.011 in embeddings, once.

What the numbers say:

- **The reply tree wins by far.** It answers all five correctly and naturally
  in 0.6 s for $0.0008: about 65 times cheaper and 20 times faster than the
  best word-by-word mode.
- **Scoring (10k) is the best word-by-word mode.** It has good openings
  ("hi paris is of france", "well depends on you is yourself") at about
  $0.05 per reply, but it still turns into word salad.
- **Wide trees beat narrow ones for single facts.** The wide word tree
  answered "capital of France?" with just `paris` and then ended the reply. For
  anything longer, it loops within 3 words.
- **30k words are worse than 10k and cost 7 times as much.** Replies pick up
  subtitle misspellings ("wouid", "ood").
- **Letters mode loops almost immediately.**

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
procedure. It can only pick the closest reply that already exists. The five
test prompts are common chatbot questions, so they suit it well.

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
row. Each is a separate decision with no plan for the whole sentence, so the
reply becomes word salad:

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
generation" and is built for fast, calibrated single decisions. The reply tree
works because it turns chatting into a few such decisions: which topic, then
which reply. Use Jev to pick answers, route requests or flag risk, and have an
LLM write any text that doesn't exist yet.

## Limits

- **255 options per choice question.** A request with 256 options is
  rejected: `Too many choices. Must have at most 255 choices.`
- **About 32K tokens per request** (state plus all questions and options),
  found by testing. A request with 19 questions of 250 words each fit, and
  more did not. The longest state that fit was about 163,000 characters.

## Files

- `chatbot.js`: the reply modes (`replyByLetters`, `replyByWords`,
  `replyByTree`, `replyByScoring`, `replyByReplyTree`)
- `chat.js`: interactive terminal chat
- `eval.js`: runs every mode on the test prompts and writes `results/`
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
- `data/tree-30k.json`, `data/tree-30k-wide.json`: word groups derived from
  `words-30k.txt`, so also CC BY-SA 4.0.
- `data/replies.txt`, `data/tree-replies.json`: reply openings from
  [OpenAssistant oasst1](https://huggingface.co/datasets/OpenAssistant/oasst1)
  (`2023-04-12_oasst_ready.messages.jsonl.gz`), trimmed and filtered as
  described above. Licensed
  [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0).

## License

The code is released under the [MIT License](LICENSE). The files in `data/`
are not covered by it. They keep the terms of their sources, listed above.
