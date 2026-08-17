import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { GGUF_QUANTS, authHeaders, buildSearchUrl, normaliseHfModel, parseQuant, pickBestQuant, toOllamaRef } from '../src/integrations/hf';

describe('buildSearchUrl', () => {
  it('targets MLC weights for WebLLM', () => {
    const url = new URL(buildSearchUrl('llama', 'mlc'));
    assert.equal(url.host, 'huggingface.co');
    assert.equal(url.searchParams.get('library'), 'mlc-llm');
    assert.match(url.searchParams.get('search') ?? '', /MLC/);
  });

  it('targets GGUF weights for Ollama', () => {
    const url = new URL(buildSearchUrl('qwen', 'gguf'));
    assert.equal(url.searchParams.get('filter'), 'gguf');
    assert.match(url.searchParams.get('search') ?? '', /GGUF/);
  });

  it('sorts by downloads descending', () => {
    const url = new URL(buildSearchUrl('', 'gguf'));
    assert.equal(url.searchParams.get('sort'), 'downloads');
    assert.equal(url.searchParams.get('direction'), '-1');
  });

  it('clamps the limit into the API range', () => {
    assert.equal(new URL(buildSearchUrl('x', 'gguf', 5000)).searchParams.get('limit'), '100');
    assert.equal(new URL(buildSearchUrl('x', 'gguf', 0)).searchParams.get('limit'), '1');
  });

  it('handles an empty query without producing a stray search term', () => {
    assert.equal(new URL(buildSearchUrl('   ', 'mlc')).searchParams.get('search'), 'MLC');
  });
});

describe('toOllamaRef', () => {
  it('builds the hf.co reference Ollama expects', () => {
    assert.equal(toOllamaRef('bartowski/Llama-3.2-3B-Instruct-GGUF', 'Q4_K_M'), 'hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M');
  });

  it('accepts a full Hugging Face URL', () => {
    assert.equal(toOllamaRef('https://huggingface.co/org/repo', 'q4_k_m'), 'hf.co/org/repo:Q4_K_M');
    assert.equal(toOllamaRef('https://hf.co/org/repo/'), 'hf.co/org/repo');
  });

  it('omits the tag when no quantisation is given', () => {
    assert.equal(toOllamaRef('org/repo'), 'hf.co/org/repo');
    assert.equal(toOllamaRef('org/repo', null), 'hf.co/org/repo');
  });

  it('rejects anything that is not org/name', () => {
    for (const input of ['repo-only', 'a/b/c', '', '   ', '/leading']) {
      assert.throws(() => toOllamaRef(input), /org\/name/);
    }
  });
});

describe('parseQuant', () => {
  it('reads standard quantisation tags', () => {
    assert.equal(parseQuant('Llama-3.2-3B-Instruct-Q4_K_M.gguf'), 'Q4_K_M');
    assert.equal(parseQuant('model.Q8_0.gguf'), 'Q8_0');
    assert.equal(parseQuant('model-IQ4_XS.gguf'), 'IQ4_XS');
    assert.equal(parseQuant('model-F16.gguf'), 'F16');
  });

  it('is case-insensitive and normalises to upper case', () => {
    assert.equal(parseQuant('model-q4_k_m.gguf'), 'Q4_K_M');
  });

  it('returns null for files with no recognisable tag', () => {
    assert.equal(parseQuant('model.gguf'), null);
    assert.equal(parseQuant('README.md'), null);
  });
});

describe('pickBestQuant', () => {
  it('prefers Q4_K_M when available', () => {
    assert.equal(pickBestQuant(['m-Q8_0.gguf', 'm-Q4_K_M.gguf', 'm-F16.gguf']), 'Q4_K_M');
  });

  it('follows the documented preference order', () => {
    assert.equal(pickBestQuant(['m-Q8_0.gguf', 'm-Q5_K_M.gguf']), 'Q5_K_M');
    assert.equal(GGUF_QUANTS.indexOf('Q4_K_M'), 0);
  });

  it('falls back to whatever exists when no preferred quant is present', () => {
    assert.equal(pickBestQuant(['m-Q2_K.gguf']), 'Q2_K');
  });

  it('returns null when nothing is quantised', () => {
    assert.equal(pickBestQuant(['README.md', 'model.gguf']), null);
    assert.equal(pickBestQuant([]), null);
  });
});

describe('normaliseHfModel', () => {
  it('reads either id or modelId', () => {
    assert.equal(normaliseHfModel({ id: 'org/repo' }, 'gguf')?.repo, 'org/repo');
    assert.equal(normaliseHfModel({ modelId: 'org/other' }, 'gguf')?.repo, 'org/other');
  });

  it('uses the trailing segment as the label', () => {
    assert.equal(normaliseHfModel({ id: 'bartowski/Llama-3.2-3B-GGUF' }, 'gguf')?.label, 'Llama-3.2-3B-GGUF');
  });

  it('treats any gated marker as gated', () => {
    assert.equal(normaliseHfModel({ id: 'a/b', gated: 'auto' }, 'gguf')?.gated, true);
    assert.equal(normaliseHfModel({ id: 'a/b', gated: true }, 'gguf')?.gated, true);
    assert.equal(normaliseHfModel({ id: 'a/b', gated: false }, 'gguf')?.gated, false);
  });

  it('drops entries with no repo id', () => {
    assert.equal(normaliseHfModel({}, 'gguf'), null);
  });
});

describe('authHeaders', () => {
  it('adds a bearer header only when a token is present', () => {
    assert.deepEqual(authHeaders('hf_abc'), { authorization: 'Bearer hf_abc' });
    assert.deepEqual(authHeaders('   '), {});
    assert.deepEqual(authHeaders(''), {});
  });

  it('trims surrounding whitespace from a pasted token', () => {
    assert.deepEqual(authHeaders('  hf_abc\n'), { authorization: 'Bearer hf_abc' });
  });
});
