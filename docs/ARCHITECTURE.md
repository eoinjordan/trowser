# Trowser Architecture

## Design objective

Chrome is the execution boundary. Page observation, inference, policy and actions stay inside
the browser unless the user explicitly configures a backend that lives elsewhere.

## Why the loop lives in the side panel

Chrome's built-in Prompt API and WebGPU are available to extension **document** contexts but
not to service workers. Putting the agent loop in the side panel is therefore not a stylistic
choice; a service-worker loop could not reach two of the four backends.

The service worker is limited to lifecycle: opening the panel, the keyboard command, and
sending first-run users to options.

## Components

```
src/
├── core/          pure logic, no chrome APIs, fully unit tested
│   ├── schema.ts      action contract + validation
│   ├── policy.ts      risk classification + hard blocks
│   ├── prompt.ts      prompt assembly + injection detection
│   ├── jsonrepair.ts  tolerant JSON extraction
│   └── settings.ts    settings coercion + redaction
├── llm/           one module per backend + shared HTTP
├── integrations/  hugging face, oauth, sign-in
├── agent/loop.ts  observe → decide → validate → assess → approve → act
├── tools/browser.ts   side-panel half of the bridge
├── content.ts     page half of the bridge
├── background.ts  service worker
├── sidepanel.*    agent UI
└── options.*      settings UI
```

The `core/` boundary is load-bearing. Nothing in it imports a Chrome API, which is what makes
the policy engine, the action contract and the prompt assembly testable in plain Node. If a
Chrome API is ever needed there, the logic belongs somewhere else.

## The provider contract

```ts
interface LlmProvider {
  readonly id: BackendId;
  readonly name: string;
  readonly locality: string;
  initialize(onProgress?, signal?): Promise<void>;
  decide(input: DecideInput): Promise<unknown>;
  dispose(): Promise<void>;
}
```

`decide` returns the **raw decoded JSON object**, not a validated action. Validation is the
loop's job, so every backend is held to exactly the same contract and a backend cannot weaken
the policy by returning something pre-approved.

Backends differ mainly in how they constrain output:

| Backend | Structured output |
|---|---|
| Chrome built-in AI | `responseConstraint` JSON schema |
| WebLLM | `response_format: json_object` with a schema, via XGrammar |
| Ollama | native `format` JSON schema on `/api/chat` |
| OpenAI-compatible | `json_schema` → `json_object` → plain, negotiated downwards |

The OpenAI-compatible provider steps down the ladder on a 400/404/422/501 and remembers the
first mode that worked, because support varies widely between LM Studio, llama.cpp, vLLM and
the rest.

Every backend feeds output through `extractJsonObject`, because constrained decoding is not
reliably honoured by small models.

## The loop

Each iteration:

1. **Observe** — a fresh bounded snapshot of the page.
2. **Decide** — the model returns one raw JSON object.
3. **Validate** — `validateAction` normalises it and rejects hallucinated ids, bad schemes and
   disallowed cross-origin navigation. Failures become repair hints and the model gets up to
   three attempts.
4. **Assess** — `assessAction` classifies risk from the action plus the snapshot it was
   grounded in.
5. **Approve** — anything sensitive or destructive stops for the user.
6. **Act** — the executor performs exactly one action.
7. **Record** — the action and result join the history the next turn sees.

Loop detection halts the run when the same action signature repeats three times. The signature
deliberately ignores `scroll` amount, because scrolling by slightly different amounts forever
is still a stuck agent.

### Retry hints

A rejected action is not simply discarded. The validation error carries a `hint` written for
the model, which is fed into the next attempt:

```
CORRECTIONS FROM THE LAST ATTEMPT:
- "e42" is not on this page. Use an id that appears in the ELEMENTS list.
```

This is what makes 1B–3B models usable rather than merely present.

## Observation

The content bridge converts the DOM into a bounded snapshot:

- Interactive elements gathered across light DOM and **open** shadow roots.
- Visibility filtering on size, `display`, `visibility`, `opacity`, `inert` and `aria-hidden`.
- Accessible names resolved roughly as a screen reader would: `aria-label`, `aria-labelledby`,
  associated `<label>`, `title`, then nested image `alt`.
- **Ranking** so a limited budget is spent on what matters: on-screen elements first, then form
  controls and links, then everything else, with disabled elements pushed down.
- Page text taken preferentially from `<main>`, `[role=main]` or `<article>` so navigation
  chrome does not consume the budget.
- Structural fingerprints per element, to survive re-renders better than a positional index.

Stale `data-trowser-id` attributes are cleared at the start of every snapshot, so an id from a
previous turn can never resolve to a different element.

Elements are rendered to the model as compact lines rather than JSON:

```
e12 <button> "Sign in" required
e13 <input:email> "Email address" offscreen
e14 <select> options=[IE|GB|FR|DE]
```

## Build

Two esbuild passes, because the contexts have incompatible module requirements:

1. `content.ts` → **IIFE**. Content scripts injected via `chrome.scripting` are classic
   scripts and cannot use ESM imports.
2. Extension pages → **ESM with code splitting**, so the 5 MB WebLLM library becomes a lazily
   loaded chunk instead of being pulled into every page.

`npm run validate` enforces both invariants, along with manifest/package version agreement,
CSP constraints, referenced-file existence and absence of key-shaped strings in the output.

## Threat model

See [SECURITY.md](SECURITY.md).
