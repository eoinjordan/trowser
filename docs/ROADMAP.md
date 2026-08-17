# Trowser Roadmap

## v0.1 — Stuffed browser

- [x] Chrome Manifest V3 extension
- [x] Side-panel agent UI
- [x] Chrome built-in Prompt API provider
- [x] WebLLM fallback provider
- [x] DOM snapshot
- [x] Grounded browser tools
- [x] Agent trace
- [x] Consequential-action approval
- [x] Brand kit and landing-page starter

## v0.2 — Backends, policy and proof

- [x] Four interchangeable backends: Chrome built-in AI, WebLLM, Ollama, OpenAI-compatible
- [x] `auto` backend resolution with per-backend remediation messages
- [x] Hugging Face model search, GGUF quantisation resolution, one-click pull into Ollama
- [x] Hugging Face token support for gated repos
- [x] Pure, unit-tested policy engine with hard blocks and approval tiers
- [x] Secret detection (Luhn card check, API keys, private keys, IBAN, national IDs)
- [x] Grounded element ids with structural fingerprints and stale-id clearing
- [x] Accessibility-oriented snapshot with open shadow DOM traversal
- [x] Element ranking so the budget goes to on-screen, actionable elements
- [x] Tolerant JSON extraction for small-model output
- [x] Decode retries that feed validation errors back as repair hints
- [x] Loop detection and step limits
- [x] Prompt-injection detection surfaced to both user and model
- [x] Inline approval and question UI, replacing blocking dialogs
- [x] Options page: backends, models, budgets, trusted origins, permissions
- [x] Optional GitHub and Google sign-in via `chrome.identity`
- [x] Optional host permissions requested per feature
- [x] 230+ unit tests across schema, policy, prompt, settings, loop, oauth, hf, zip
- [x] `validate` release gate for the built extension
- [x] Reproducible packaging with checksums
- [x] CI on Node 20 and 22, tagged releases, manual Pages deploy

## v0.3 — Reliability

- [ ] Post-action verification: assert the page reached the expected state
- [ ] Retry and recovery policy per failure class
- [ ] Deterministic local fixture sites for end-to-end tests
- [ ] Headless end-to-end harness driving the real extension
- [ ] Recorded and replayable traces
- [ ] Structured task-completion evaluator
- [ ] Adversarial prompt-injection corpus with measured pass rate
- [ ] Non-English risk classification

## v0.4 — Skills

- [ ] Save a completed run as a reusable local skill
- [ ] Parameterised skill inputs
- [ ] Per-origin skill permissions
- [ ] Skill dry-run mode
- [ ] Local skill registry in IndexedDB
- [ ] Import/export and Gist/Drive sync of skills

## v0.5 — Multi-tab and local tools

- [ ] Read-only context from explicitly selected tabs
- [ ] Tab-scoped permissions and cross-tab working memory
- [ ] Explicit approval before acting in a second tab
- [ ] Local MCP-style tool bridge with a capability manifest
- [ ] Read-only local file tool behind an explicit picker

## Evaluation targets

Tracked per release, per backend:

- task completion rate
- median actions per successful task
- unnecessary-action rate
- invalid-element-action rate
- user-intervention rate
- consequential-action false positive and false negative rate
- prompt-injection resistance rate
- local inference latency per step
- peak browser memory and VRAM
- bytes sent off-device during a task (target: zero for on-device backends)
