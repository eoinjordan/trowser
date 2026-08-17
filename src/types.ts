/**
 * Shared types for Trowser.
 *
 * This module is deliberately dependency-free and contains no Chrome API
 * references so it can be imported by unit tests running in plain Node.
 */

export type ToolName =
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'
  | 'key'
  | 'navigate'
  | 'back'
  | 'read'
  | 'wait'
  | 'ask'
  | 'finish';

export type RiskLevel = 'none' | 'sensitive' | 'destructive' | 'blocked';

export interface PageElement {
  /** Snapshot-scoped grounding id, e.g. "e12". Never a CSS selector. */
  id: string;
  /** Structural fingerprint used to re-find an element after a DOM update. */
  fp: string;
  tag: string;
  role?: string;
  type?: string;
  name?: string;
  text?: string;
  ariaLabel?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  href?: string;
  /** True when the element sits inside a <form>. Used by the policy engine. */
  inForm?: boolean;
  /** True when the element is inside the current viewport. */
  inView?: boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface PageSnapshot {
  title: string;
  url: string;
  origin: string;
  /** Bounded, cleaned visible text of the page. */
  text: string;
  /** True when the text was truncated to fit the budget. */
  textTruncated: boolean;
  elements: PageElement[];
  /** Count of interactive elements found before the element budget was applied. */
  totalElements: number;
  scroll: { y: number; height: number; viewport: number };
  capturedAt: number;
}

export interface AgentAction {
  tool: ToolName;
  targetId?: string;
  text?: string;
  value?: string;
  url?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  ms?: number;
  submit?: boolean;
  question?: string;
  answer?: string;
  reason: string;
}

export interface ToolResult {
  ok: boolean;
  message: string;
  risk?: RiskLevel;
  /** Optional page text returned by the `read` tool. */
  data?: string;
  /** Set when the action is believed to have changed page state. */
  changed?: boolean;
}

export interface HistoryEntry {
  action: AgentAction;
  result: ToolResult;
}

export type AgentEventKind =
  | 'status'
  | 'model'
  | 'action'
  | 'result'
  | 'approval'
  | 'warning'
  | 'done'
  | 'error';

export interface AgentEvent {
  kind: AgentEventKind;
  message: string;
  action?: AgentAction;
  step?: number;
  at?: number;
}

export interface DecideInput {
  goal: string;
  snapshot: PageSnapshot;
  history: HistoryEntry[];
  /** Notes the loop wants the model to see, e.g. a repair hint after bad JSON. */
  hints?: string[];
  signal?: AbortSignal;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Approximate download size in MB, when the backend can report it. */
  sizeMb?: number;
  /** True when the weights are already cached locally. */
  installed?: boolean;
}

export interface ProviderStatus {
  ok: boolean;
  detail: string;
  /** Actionable remediation shown in the UI when ok is false. */
  fix?: string;
}

export interface LlmProvider {
  readonly id: BackendId;
  readonly name: string;
  /** Human-readable description of where inference physically happens. */
  readonly locality: string;
  initialize(onProgress?: (message: string) => void, signal?: AbortSignal): Promise<void>;
  /**
   * Returns the raw JSON object decoded from the model. Validation is the
   * agent loop's job, so that every backend is held to the same contract.
   */
  decide(input: DecideInput): Promise<unknown>;
  dispose(): Promise<void>;
}

export type BackendId = 'chrome-ai' | 'webllm' | 'ollama' | 'openai-compatible';

export interface BackendConfig {
  backend: BackendId | 'auto';
  webllmModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
}

export interface AgentConfig {
  maxSteps: number;
  /** Require approval for every action, not just risky ones. */
  approveEverything: boolean;
  /** Allow the model to navigate to a different origin. */
  allowCrossOrigin: boolean;
  /** Origins the user has pre-approved for autonomous action. */
  trustedOrigins: string[];
  /** Maximum characters of page text sent to the model per step. */
  textBudget: number;
  /** Maximum interactive elements sent to the model per step. */
  elementBudget: number;
}

export interface IntegrationConfig {
  /** Hugging Face access token, used for gated repos and higher rate limits. */
  hfToken: string;
  /** OAuth app client id the user registered for GitHub sign-in. */
  githubClientId: string;
  /** OAuth client id the user registered for Google sign-in. */
  googleClientId: string;
}

export interface Settings extends BackendConfig, AgentConfig, IntegrationConfig {}

export type AuthProviderId = 'github' | 'google';

export interface Account {
  provider: AuthProviderId;
  /** Stable provider-side identifier. */
  id: string;
  login: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  /** Epoch ms at which the stored token expires, when the provider says so. */
  expiresAt?: number;
  scopes: string[];
}

export interface RunRecord {
  id: string;
  goal: string;
  origin: string;
  backend: string;
  startedAt: number;
  endedAt?: number;
  outcome: 'running' | 'done' | 'error' | 'stopped';
  answer?: string;
  events: AgentEvent[];
}

export interface Skill {
  id: string;
  name: string;
  goal: string;
  origin: string;
  createdAt: number;
  steps: AgentAction[];
}
