/**
 * Tolerant JSON extraction for small local models.
 *
 * Backends without constrained decoding routinely wrap their answer in prose,
 * markdown fences, or `<think>` blocks, and emit trailing commas or single
 * quotes. Failing the whole step on that would make 1B-class models unusable,
 * so we repair what is unambiguously repairable and reject the rest.
 */

export class JsonExtractionError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

/**
 * Pulls the first plausible JSON object out of arbitrary model output.
 * Throws JsonExtractionError when nothing parseable is present.
 */
export function extractJsonObject(text: string): unknown {
  if (typeof text !== 'string' || !text.trim()) {
    throw new JsonExtractionError('Model returned an empty response.', String(text ?? ''));
  }

  const cleaned = stripWrappers(text);

  for (const candidate of candidateSlices(cleaned)) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
  }

  throw new JsonExtractionError('No JSON object found in model output.', text.slice(0, 400));
}

/** Removes reasoning blocks and markdown fences that wrap the payload. */
export function stripWrappers(text: string): string {
  let output = text;

  // Reasoning traces emitted by distilled R1-style models.
  output = output.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  output = output.replace(/<\|[^|]*\|>/g, ' ');

  // An unterminated <think> block means everything before it is preamble.
  const openThink = output.toLowerCase().lastIndexOf('<think>');
  if (openThink !== -1) output = output.slice(0, openThink);

  // Prefer the contents of a fenced block when one is present.
  const fence = output.match(/```(?:json|jsonc|js)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) return fence[1].trim();

  // An unterminated fence still marks the start of the payload.
  const openFence = output.match(/```(?:json|jsonc|js)?\s*([\s\S]*)$/i);
  if (openFence && openFence[1].includes('{')) return openFence[1].trim();

  return output.trim();
}

/**
 * Yields balanced `{...}` slices, longest first, so that a nested object never
 * shadows the full action object.
 */
function candidateSlices(text: string): string[] {
  const slices: string[] = [];

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchBrace(text, start);
    if (end !== -1) slices.push(text.slice(start, end + 1));
    if (slices.length >= 12) break;
  }

  // A truncated response may never close its brace; try closing it ourselves.
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    const tail = text.slice(firstBrace);
    const missing = countUnclosed(tail);
    if (missing > 0) slices.push(tail + '}'.repeat(missing));
  }

  return slices.sort((a, b) => b.length - a.length);
}

/** Returns the index of the brace closing the one at `start`, or -1. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (inString) {
      if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function countUnclosed(text: string): number {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (inString) {
      if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
  }

  return Math.max(depth, 0);
}

function tryParse(candidate: string): unknown {
  const attempts = [candidate, repairJson(candidate)];

  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Fall through to the next repair strategy.
    }
  }

  return undefined;
}

/** Applies conservative, order-independent fixes for common model mistakes. */
export function repairJson(text: string): string {
  let output = text;

  // Trailing commas before a closing brace or bracket.
  output = output.replace(/,(\s*[}\]])/g, '$1');

  // Unquoted keys: {tool: "click"} -> {"tool": "click"}
  output = output.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');

  // Single-quoted strings, leaving apostrophes inside double quotes alone.
  output = output.replace(/'((?:[^'\\]|\\.)*)'/g, (_match, inner: string) => {
    return '"' + inner.replace(/"/g, '\\"') + '"';
  });

  // Python and JS literals that are not valid JSON.
  output = output.replace(/\b(True|False|None)\b/g, (match) => {
    if (match === 'True') return 'true';
    if (match === 'False') return 'false';
    return 'null';
  });
  output = output.replace(/:\s*undefined\b/g, ': null');

  return output;
}
