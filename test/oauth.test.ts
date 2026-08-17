import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  OAuthError,
  PROVIDERS,
  base64UrlEncode,
  buildAuthorizeUrl,
  isExpired,
  looksLikeGitHubToken,
  looksLikeHfToken,
  parseDeviceCodeResponse,
  parseDevicePoll,
  parseImplicitCallback,
  randomString,
  sha256Base64Url
} from '../src/integrations/oauth';

const REDIRECT = 'https://abcdef.chromiumapp.org/oauth';

describe('buildAuthorizeUrl', () => {
  it('includes client id, redirect, scopes and state', () => {
    const url = new URL(buildAuthorizeUrl({ spec: PROVIDERS.google, clientId: 'cid', redirectUri: REDIRECT, state: 'st' }));

    assert.equal(url.searchParams.get('client_id'), 'cid');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(url.searchParams.get('state'), 'st');
    assert.equal(url.searchParams.get('response_type'), 'token');
    assert.match(url.searchParams.get('scope') ?? '', /openid/);
  });

  it('trims the client id', () => {
    const url = new URL(buildAuthorizeUrl({ spec: PROVIDERS.google, clientId: '  cid  ', redirectUri: REDIRECT, state: 's' }));
    assert.equal(url.searchParams.get('client_id'), 'cid');
  });

  it('de-duplicates extra scopes', () => {
    const url = new URL(
      buildAuthorizeUrl({ spec: PROVIDERS.google, clientId: 'c', redirectUri: REDIRECT, state: 's', scopes: ['openid', 'extra'] })
    );
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    assert.equal(scopes.filter((scope) => scope === 'openid').length, 1);
    assert.ok(scopes.includes('extra'));
  });

  it('explains how to fix a missing client id', () => {
    assert.throws(
      () => buildAuthorizeUrl({ spec: PROVIDERS.google, clientId: '   ', redirectUri: REDIRECT, state: 's' }),
      (error: unknown) => error instanceof OAuthError && /console\.cloud\.google\.com/.test(error.fix ?? '')
    );
  });
});

describe('parseImplicitCallback', () => {
  const good = REDIRECT + '#access_token=tok123&expires_in=3600&scope=openid%20email&state=st';

  it('extracts the token, expiry and scopes', () => {
    const result = parseImplicitCallback(good, 'st', 1_000_000);
    assert.equal(result.accessToken, 'tok123');
    assert.equal(result.expiresAt, 1_000_000 + 3_600_000);
    assert.deepEqual(result.scopes, ['openid', 'email']);
  });

  it('rejects a mismatched state', () => {
    assert.throws(() => parseImplicitCallback(good, 'different'), (error: unknown) => error instanceof OAuthError && /state did not match/.test(error.message));
  });

  it('rejects a missing state, which would allow a replayed response', () => {
    assert.throws(() => parseImplicitCallback(REDIRECT + '#access_token=t', 'st'), /state did not match/);
  });

  it('surfaces a provider error from the fragment or the query', () => {
    assert.throws(() => parseImplicitCallback(REDIRECT + '#error=access_denied&state=st', 'st'), /access_denied/);
    assert.throws(() => parseImplicitCallback(REDIRECT + '?error=invalid_scope&state=st', 'st'), /invalid_scope/);
  });

  it('rejects a response with no token', () => {
    assert.throws(() => parseImplicitCallback(REDIRECT + '#state=st&scope=openid', 'st'), /did not return an access token/);
  });

  it('rejects a malformed redirect url', () => {
    assert.throws(() => parseImplicitCallback('not a url', 'st'), /malformed/);
  });

  it('omits expiry when the provider does not supply one', () => {
    assert.equal(parseImplicitCallback(REDIRECT + '#access_token=t&state=st', 'st').expiresAt, undefined);
  });
});

describe('parseDeviceCodeResponse', () => {
  it('reads the device and user codes', () => {
    const result = parseDeviceCodeResponse(
      { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 },
      1_000
    );

    assert.equal(result.deviceCode, 'dc');
    assert.equal(result.userCode, 'ABCD-1234');
    assert.equal(result.intervalMs, 5000);
    assert.equal(result.expiresAt, 901_000);
  });

  it('enforces a minimum poll interval', () => {
    const result = parseDeviceCodeResponse({ device_code: 'd', user_code: 'u', verification_uri: 'https://x', interval: 1 });
    assert.equal(result.intervalMs, 5000);
  });

  it('explains how to enable device flow when GitHub refuses', () => {
    assert.throws(
      () => parseDeviceCodeResponse({ error: 'device_flow_disabled' }),
      (error: unknown) => error instanceof OAuthError && /Device flow/.test(error.fix ?? '')
    );
  });

  it('rejects a malformed payload', () => {
    for (const payload of [null, undefined, 'nope', 42, {}]) {
      assert.throws(() => parseDeviceCodeResponse(payload), OAuthError);
    }
  });
});

describe('parseDevicePoll', () => {
  it('returns the token on success', () => {
    const result = parseDevicePoll({ access_token: 'gho_x', scope: 'gist,read:user' }, 5000);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' ? result.scopes : [], ['gist', 'read:user']);
  });

  it('keeps polling while authorization is pending', () => {
    assert.equal(parseDevicePoll({ error: 'authorization_pending' }, 5000).status, 'pending');
  });

  it('backs off when told to slow down', () => {
    const result = parseDevicePoll({ error: 'slow_down' }, 5000);
    assert.equal(result.status, 'slow_down');
    assert.equal(result.status === 'slow_down' ? result.intervalMs : 0, 10000);
  });

  it('throws on terminal errors', () => {
    assert.throws(() => parseDevicePoll({ error: 'expired_token' }, 5000), /expired/);
    assert.throws(() => parseDevicePoll({ error: 'access_denied' }, 5000), /cancelled/);
    assert.throws(() => parseDevicePoll({ error: 'incorrect_client_credentials' }, 5000), /client ID/);
    assert.throws(() => parseDevicePoll({}, 5000), OAuthError);
  });
});

describe('token shape checks', () => {
  it('accepts modern and classic GitHub tokens', () => {
    assert.equal(looksLikeGitHubToken('ghp_' + 'a'.repeat(36)), true);
    assert.equal(looksLikeGitHubToken('gho_' + 'b'.repeat(36)), true);
    assert.equal(looksLikeGitHubToken('a1b2c3d4'.repeat(5)), true);
  });

  it('rejects obvious paste errors', () => {
    for (const token of ['', 'hello', 'ghp_short', 'sk-' + 'a'.repeat(32)]) {
      assert.equal(looksLikeGitHubToken(token), false);
    }
  });

  it('recognises Hugging Face tokens', () => {
    assert.equal(looksLikeHfToken('hf_' + 'a'.repeat(30)), true);
    assert.equal(looksLikeHfToken('ghp_' + 'a'.repeat(36)), false);
  });
});

describe('isExpired', () => {
  it('treats a token inside the skew window as expired', () => {
    assert.equal(isExpired(1000, 1000), true);
    assert.equal(isExpired(100_000, 50_000), true);
    assert.equal(isExpired(100_000, 1_000), false);
  });

  it('treats a token with no expiry as valid', () => {
    assert.equal(isExpired(undefined), false);
  });
});

describe('crypto helpers', () => {
  it('randomString produces distinct url-safe values', () => {
    const values = new Set(Array.from({ length: 50 }, () => randomString(16)));
    assert.equal(values.size, 50);
    for (const value of values) assert.match(value, /^[A-Za-z0-9_-]+$/);
  });

  it('base64UrlEncode omits padding and url-unsafe characters', () => {
    const encoded = base64UrlEncode(new Uint8Array([251, 255, 190, 255]));
    assert.ok(!encoded.includes('='));
    assert.ok(!encoded.includes('+'));
    assert.ok(!encoded.includes('/'));
  });

  it('sha256Base64Url matches the known digest of "abc"', async () => {
    assert.equal(await sha256Base64Url('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});
