import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS, normaliseSettings, origins, redactSettings } from '../src/core/settings';

describe('normaliseSettings: defaults', () => {
  it('returns defaults for empty, null and non-object input', () => {
    for (const input of [undefined, null, {}, 'nonsense', 42, []]) {
      assert.deepEqual(normaliseSettings(input), DEFAULT_SETTINGS);
    }
  });

  it('defaults the backend to auto when the stored value is unknown', () => {
    assert.equal(normaliseSettings({ backend: 'gpt-9' }).backend, 'auto');
  });

  it('accepts each valid backend id', () => {
    for (const backend of ['auto', 'chrome-ai', 'webllm', 'ollama', 'openai-compatible']) {
      assert.equal(normaliseSettings({ backend }).backend, backend);
    }
  });
});

describe('normaliseSettings: numeric clamping', () => {
  it('clamps maxSteps into a workable range', () => {
    assert.equal(normaliseSettings({ maxSteps: 0 }).maxSteps, 1);
    assert.equal(normaliseSettings({ maxSteps: 5000 }).maxSteps, 60);
    assert.equal(normaliseSettings({ maxSteps: 'ten' }).maxSteps, DEFAULT_SETTINGS.maxSteps);
    assert.equal(normaliseSettings({ maxSteps: 12.6 }).maxSteps, 13);
  });

  it('clamps the text and element budgets', () => {
    assert.equal(normaliseSettings({ textBudget: 10 }).textBudget, 500);
    assert.equal(normaliseSettings({ textBudget: 10_000_000 }).textBudget, 40000);
    assert.equal(normaliseSettings({ elementBudget: 1 }).elementBudget, 10);
    assert.equal(normaliseSettings({ elementBudget: 9999 }).elementBudget, 300);
  });

  it('rejects NaN and Infinity', () => {
    assert.equal(normaliseSettings({ maxSteps: NaN }).maxSteps, DEFAULT_SETTINGS.maxSteps);
    assert.equal(normaliseSettings({ textBudget: Infinity }).textBudget, DEFAULT_SETTINGS.textBudget);
  });
});

describe('normaliseSettings: urls', () => {
  it('strips trailing slashes from base urls', () => {
    assert.equal(normaliseSettings({ ollamaBaseUrl: 'http://127.0.0.1:11434///' }).ollamaBaseUrl, 'http://127.0.0.1:11434');
  });

  it('falls back to the default for a malformed or non-http url', () => {
    assert.equal(normaliseSettings({ ollamaBaseUrl: 'not a url' }).ollamaBaseUrl, DEFAULT_SETTINGS.ollamaBaseUrl);
    assert.equal(normaliseSettings({ openaiBaseUrl: 'javascript:alert(1)' }).openaiBaseUrl, DEFAULT_SETTINGS.openaiBaseUrl);
    assert.equal(normaliseSettings({ openaiBaseUrl: 'file:///etc/passwd' }).openaiBaseUrl, DEFAULT_SETTINGS.openaiBaseUrl);
  });

  it('keeps a valid https endpoint', () => {
    assert.equal(
      normaliseSettings({ openaiBaseUrl: 'https://router.huggingface.co/v1' }).openaiBaseUrl,
      'https://router.huggingface.co/v1'
    );
  });
});

describe('normaliseSettings: booleans and strings', () => {
  it('only accepts real booleans', () => {
    assert.equal(normaliseSettings({ approveEverything: 'true' }).approveEverything, false);
    assert.equal(normaliseSettings({ approveEverything: 1 }).approveEverything, false);
    assert.equal(normaliseSettings({ approveEverything: true }).approveEverything, true);
  });

  it('allows secrets and optional model names to be empty', () => {
    const settings = normaliseSettings({ openaiApiKey: '', hfToken: '', openaiModel: '' });
    assert.equal(settings.openaiApiKey, '');
    assert.equal(settings.hfToken, '');
    assert.equal(settings.openaiModel, '');
  });

  it('trims stored secrets', () => {
    assert.equal(normaliseSettings({ hfToken: '  hf_abc  ' }).hfToken, 'hf_abc');
  });

  it('restores the default model name when a required string is blanked', () => {
    assert.equal(normaliseSettings({ webllmModel: '   ' }).webllmModel, DEFAULT_SETTINGS.webllmModel);
  });
});

describe('origins', () => {
  it('normalises entries to bare origins', () => {
    assert.deepEqual(origins(['https://example.com/some/path?q=1']), ['https://example.com']);
  });

  it('drops malformed and non-http entries', () => {
    assert.deepEqual(origins(['nope', 'javascript:alert(1)', 'file:///x', 42, null]), []);
  });

  it('de-duplicates', () => {
    assert.deepEqual(origins(['https://a.com', 'https://a.com/x', 'https://a.com']), ['https://a.com']);
  });

  it('returns an empty list for non-array input', () => {
    assert.deepEqual(origins('https://a.com'), []);
    assert.deepEqual(origins(undefined), []);
  });

  it('caps the list length', () => {
    const many = Array.from({ length: 500 }, (_, index) => 'https://site' + index + '.com');
    assert.equal(origins(many).length, 100);
  });
});

describe('redactSettings', () => {
  it('never emits secret values', () => {
    const redacted = redactSettings(normaliseSettings({ openaiApiKey: 'sk-secret', hfToken: 'hf_secret' }));
    assert.equal(redacted.openaiApiKey, '[set]');
    assert.equal(redacted.hfToken, '[set]');
    assert.ok(!JSON.stringify(redacted).includes('secret'));
  });

  it('leaves unset secrets as empty strings', () => {
    const redacted = redactSettings(DEFAULT_SETTINGS);
    assert.equal(redacted.openaiApiKey, '');
    assert.equal(redacted.hfToken, '');
  });
});
