import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { JsonExtractionError, extractJsonObject, repairJson, stripWrappers } from '../src/core/jsonrepair';

function extract(text: string): Record<string, unknown> {
  return extractJsonObject(text) as Record<string, unknown>;
}

describe('extractJsonObject: clean input', () => {
  it('parses a bare object', () => {
    assert.deepEqual(extract('{"tool":"click","targetId":"e1","reason":"go"}'), {
      tool: 'click',
      targetId: 'e1',
      reason: 'go'
    });
  });

  it('tolerates surrounding whitespace and newlines', () => {
    assert.equal(extract('\n\n  {"tool":"back","reason":"r"}  \n').tool, 'back');
  });
});

describe('extractJsonObject: wrapped output', () => {
  it('unwraps a fenced json block', () => {
    assert.equal(extract('Sure!\n```json\n{"tool":"finish","answer":"hi","reason":"r"}\n```\nHope that helps.').tool, 'finish');
  });

  it('unwraps an unlabelled fence', () => {
    assert.equal(extract('```\n{"tool":"scroll","reason":"r"}\n```').tool, 'scroll');
  });

  it('unwraps an unterminated fence from a truncated stream', () => {
    assert.equal(extract('```json\n{"tool":"read","reason":"r"}').tool, 'read');
  });

  it('strips a closed <think> block', () => {
    const raw = '<think>The user wants pricing. I should click e2.</think>{"tool":"click","targetId":"e2","reason":"r"}';
    assert.equal(extract(raw).targetId, 'e2');
  });

  it('drops an unterminated <think> block and keeps the object before it', () => {
    assert.deepEqual(extract('{"tool":"back","reason":"r"} <think> now I will scroll'), { tool: 'back', reason: 'r' });
  });

  it('throws when an unterminated <think> block swallows the whole payload', () => {
    assert.throws(() => extractJsonObject('<think> I should emit {"tool":"back"}'), JsonExtractionError);
  });

  it('ignores chat template control tokens', () => {
    assert.equal(extract('<|assistant|>{"tool":"wait","reason":"r"}<|end|>').tool, 'wait');
  });

  it('picks the outermost object rather than a nested one', () => {
    const raw = '{"tool":"select","value":"IE","meta":{"tool":"click"},"reason":"r"}';
    assert.equal(extract(raw).tool, 'select');
  });

  it('finds an object embedded in prose', () => {
    assert.equal(extract('I will click the link. {"tool":"click","targetId":"e1","reason":"r"} Done.').tool, 'click');
  });
});

describe('extractJsonObject: malformed output', () => {
  it('repairs trailing commas', () => {
    assert.equal(extract('{"tool":"back","reason":"r",}').tool, 'back');
  });

  it('repairs unquoted keys', () => {
    assert.equal(extract('{tool:"click",targetId:"e1",reason:"r"}').targetId, 'e1');
  });

  it('repairs single-quoted strings', () => {
    assert.equal(extract("{'tool':'click','targetId':'e1','reason':'r'}").tool, 'click');
  });

  it('repairs Python literals', () => {
    assert.equal(extract('{"tool":"type","targetId":"e1","text":"x","submit":True,"reason":"r"}').submit, true);
  });

  it('closes a truncated object', () => {
    assert.equal(extract('{"tool":"finish","answer":"the Pro plan","reason":"r"').tool, 'finish');
  });

  it('preserves apostrophes inside double-quoted strings', () => {
    assert.equal(extract('{"tool":"finish","answer":"it\'s the Pro plan","reason":"r"}').answer, "it's the Pro plan");
  });

  it('preserves escaped quotes', () => {
    assert.equal(extract('{"tool":"finish","answer":"say \\"hi\\"","reason":"r"}').answer, 'say "hi"');
  });

  it('does not confuse braces inside string values', () => {
    assert.equal(extract('{"tool":"type","targetId":"e1","text":"{not json}","reason":"r"}').text, '{not json}');
  });
});

describe('extractJsonObject: rejection', () => {
  it('throws on empty or non-string input', () => {
    for (const input of ['', '   ', null as unknown as string, undefined as unknown as string]) {
      assert.throws(() => extractJsonObject(input), JsonExtractionError);
    }
  });

  it('throws when there is no object at all', () => {
    assert.throws(() => extractJsonObject('I am unable to help with that request.'), JsonExtractionError);
  });

  it('unwraps a single action mistakenly wrapped in an array', () => {
    // Small models often emit a one-element array. Recovering the object is
    // safe because validateAction still gates every field afterwards.
    assert.equal(extract('[{"tool":"click","targetId":"e1","reason":"r"}]').tool, 'click');
  });

  it('throws on an array of primitives with no object inside', () => {
    assert.throws(() => extractJsonObject('["click", "e1"]'), JsonExtractionError);
  });

  it('carries a truncated copy of the raw output for diagnostics', () => {
    try {
      extractJsonObject('x'.repeat(2000));
      assert.fail('expected throw');
    } catch (error) {
      assert.ok(error instanceof JsonExtractionError);
      assert.ok(error.raw.length <= 400);
    }
  });
});

describe('stripWrappers and repairJson are individually sound', () => {
  it('stripWrappers returns fence contents', () => {
    assert.equal(stripWrappers('a\n```json\n{"x":1}\n```\nb'), '{"x":1}');
  });

  it('repairJson is idempotent on already-valid json', () => {
    const valid = '{"tool":"click","targetId":"e1"}';
    assert.equal(repairJson(valid), valid);
  });
});
