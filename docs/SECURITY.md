# Trowser Security Model

## Threat model

Trowser runs a language model that reads an untrusted web page and then acts on that page
with the user's own browser session and cookies. Three things can go wrong:

1. **Prompt injection.** A page contains text crafted to redirect the agent.
2. **Model error.** The model is small and local, and simply gets it wrong.
3. **Over-broad capability.** The agent can reach further than the task requires.

The design answer to all three is the same: **capability before autonomy**. Correctness of
the model is never the thing standing between a page and a consequential action.

## The capability boundary

The model does not act on the page. It emits one JSON object per turn, and the executor
decides whether anything happens. What the model can express is the entire attack surface:

```ts
type ToolName =
  | 'click' | 'type' | 'select' | 'scroll' | 'key'
  | 'navigate' | 'back' | 'read' | 'wait' | 'ask' | 'finish';
```

There is deliberately **no** `evaluate`, `querySelector`, `fetch`, `openTab`, `readCookies`
or `executeScript` tool. An injected instruction cannot request a capability that does not
exist.

### Grounding

Element-targeting actions carry a `targetId` such as `e7`, allocated by the content bridge
during the snapshot it just took. Validation rejects any id absent from the current snapshot,
so a hallucinated or injected id fails closed. Stale ids are cleared from the DOM at the start
of every snapshot, so an id can never silently resolve to a different element than the model
was shown.

### URL handling

`navigate` parses the URL and rejects any scheme other than `http:` and `https:`, which
blocks `javascript:`, `data:` and `file:`. Cross-origin navigation is refused unless the user
turns it on.

## Hard blocks

These are enforced in the policy engine *and* independently re-checked in the page executor,
so a bug in one layer does not defeat both. No setting disables them.

| Blocked | Why |
|---|---|
| Typing into `input[type=password]` | Credential entry is never automated |
| Typing into `input[type=file]` | Prevents unintended file exfiltration |
| Text matching a Luhn-valid card number | Payment details are never entered |
| Text matching API keys, private keys, IBANs, national IDs | Secret exfiltration into a page |
| Interacting with a disabled element | Fails closed rather than forcing an event |

Password field *values* are never read into a snapshot at all.

## Approval gates

`assessAction` is a pure function of the action, the snapshot it was grounded in, and the
user's config. It returns `none`, `sensitive`, `destructive` or `blocked`.

- **Destructive** — delete, remove, erase, revoke, deactivate, terminate, cancel subscription,
  close account, sign out. **Always** requires human approval, on every origin, including
  trusted ones. There is no way to auto-approve these.
- **Sensitive** — pay, purchase, order, checkout, send, submit, publish, share, book, apply,
  donate, transfer, subscribe. Also: clicking a form submit control, pressing Enter, typing
  into an email or tel field, and any type-then-submit. Requires approval unless the origin
  is explicitly trusted.
- **None** — ordinary reading, scrolling and navigation within the same origin.

Approval is requested inline in the side panel, showing the action, the element and the
reason it was flagged. It is not a blind `window.confirm`.

## Containment

- **`activeTab`**, not a standing `<all_urls>` content-script registration. The bridge is
  injected into one tab, for one task, on user initiation.
- **Optional host permissions.** Nothing is granted at install time. Localhost, Hugging Face,
  GitHub and Google origins are requested individually from the options page, only when the
  corresponding feature is used.
- **No remote code.** The CSP forbids `unsafe-eval` and wildcard script sources. `wasm-unsafe-eval`
  is allowed solely so WebLLM can compile its WebGPU kernels. `npm run validate` fails the
  build if these constraints regress.
- **Bounded observation.** Element count and page-text length are capped, which limits both
  the injection surface and the token cost.
- **Bounded autonomy.** A per-run step limit, plus loop detection that halts an agent
  repeating the same action.

## Prompt injection

Page text is fenced inside `<page>` delimiters, and the system prompt states that content
inside those delimiters is data and never an instruction.

Beyond that, `detectInjection` scans page text for known patterns: instruction overrides,
role reassignment, fake system messages, fake prompt delimiters and prompt-exfiltration
attempts. Findings are **surfaced rather than stripped** — the user sees a warning in the
trace, and the model receives an explicit notice that the page tried to instruct it.

This is a mitigation, not a solution. Detection is pattern-based and will miss novel phrasings.
The real protection is that a successful injection still cannot express a dangerous action,
still cannot target an element outside the snapshot, and still cannot get past the approval
gate on anything consequential.

## Secrets

- Tokens live in `chrome.storage.local`, scoped to the browser profile. Never `storage.sync`.
- Secrets are never rendered back into the DOM; the options page shows a placeholder.
- `redactSettings` is used anywhere settings could reach a log or trace.
- `npm run validate` greps the built output for key-shaped strings and fails the build on a hit.
- Each token is sent only to the provider it belongs to.

## What is not solved

Stated plainly, because a security document that only lists wins is not useful:

- **Injection detection is heuristic.** A novel phrasing will get through to the model. The
  capability boundary is the real defence, not the detector.
- **Keyword risk classification is shallow.** A destructive control with an unusual label
  (an icon-only button, a non-English label) may be classified as routine. A stronger version
  needs element semantics, site policy and transaction state, not a word list.
- **No per-origin capability grants yet.** Trust is currently all-or-nothing per origin.
- **No post-action verification.** The loop records what happened but does not assert that the
  page reached an expected state.
- **Non-English pages are weakly covered** by the risk patterns.
- **Open shadow DOM only.** Closed shadow roots and cross-origin iframes are invisible, which
  is safe but incomplete.
- **No adversarial evaluation corpus.** Until there is one, robustness claims are untested
  against a real attacker.

## Reporting

Please open a security advisory on the repository rather than a public issue.
