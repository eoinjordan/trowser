/**
 * Ambient types for Chrome's built-in AI (Prompt API).
 *
 * These ship in Chrome but are not yet in @types/chrome, so they are declared
 * here against the shape documented for Chrome 138+.
 */

type LanguageModelAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LanguageModelExpectation {
  type: 'text' | 'image' | 'audio';
  languages?: string[];
}

interface LanguageModelCreateOptions {
  initialPrompts?: LanguageModelMessage[];
  expectedInputs?: LanguageModelExpectation[];
  expectedOutputs?: LanguageModelExpectation[];
  temperature?: number;
  topK?: number;
  monitor?: (monitor: EventTarget) => void;
  signal?: AbortSignal;
}

interface LanguageModelPromptOptions {
  /** JSON schema constraining the decoded output. */
  responseConstraint?: object;
  omitResponseConstraintInput?: boolean;
  signal?: AbortSignal;
}

interface LanguageModelParams {
  defaultTopK: number;
  maxTopK: number;
  defaultTemperature: number;
  maxTemperature: number;
}

interface LanguageModelSession {
  prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;
  promptStreaming(input: string, options?: LanguageModelPromptOptions): ReadableStream<string>;
  readonly inputUsage?: number;
  readonly inputQuota?: number;
  destroy(): void;
}

interface LanguageModelStatic {
  availability(options?: LanguageModelCreateOptions): Promise<LanguageModelAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
  params(): Promise<LanguageModelParams | null>;
}

declare const LanguageModel: LanguageModelStatic | undefined;

interface Window {
  LanguageModel?: LanguageModelStatic;
}
