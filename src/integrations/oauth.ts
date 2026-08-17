/**
 * OAuth primitives.
 *
 * Trowser has no backend, so every flow here must work as a public client with
 * no client secret. That constraint decides the flow per provider:
 *
 *   Google - implicit flow via chrome.identity.launchWebAuthFlow. Google issues
 *            the access token straight into the redirect fragment, so no token
 *            endpoint call (and therefore no CORS problem) is needed.
 *   GitHub - device flow, which is the only GitHub flow that omits the client
 *            secret. A pasted personal access token is offered alongside it
 *            because some networks block the device endpoints from a browser.
 *
 * Everything in this module is pure and network-free so it can be unit tested.
 */

import type { AuthProviderId } from '../types';

export interface ProviderSpec {
  id: AuthProviderId;
  label: string;
  authorizeUrl: string;
  scopes: string[];
  /** Implicit flow returns the token in the fragment; device flow polls. */
  flow: 'implicit' | 'device';
  deviceCodeUrl?: string;
  deviceTokenUrl?: string;
  /** Where to send the user to create a client id. */
  setupUrl: string;
}

export const PROVIDERS: Record<AuthProviderId, ProviderSpec> = {
  google: {
    id: 'google',
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.appdata'],
    flow: 'implicit',
    setupUrl: 'https://console.cloud.google.com/apis/credentials'
  },
  github: {
    id: 'github',
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/device',
    scopes: ['gist', 'read:user'],
    flow: 'device',
    deviceCodeUrl: 'https://github.com/login/device/code',
    deviceTokenUrl: 'https://github.com/login/oauth/access_token',
    setupUrl: 'https://github.com/settings/developers'
  }
};

export class OAuthError extends Error {
  constructor(message: string, readonly fix?: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

/** Cryptographically random URL-safe string, used for state and PKCE. */
export function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

export interface AuthUrlParams {
  spec: ProviderSpec;
  clientId: string;
  redirectUri: string;
  state: string;
  /** Extra scopes appended to the provider defaults. */
  scopes?: string[];
}

export function buildAuthorizeUrl(params: AuthUrlParams): string {
  if (!params.clientId.trim()) {
    throw new OAuthError(
      'No ' + params.spec.label + ' client ID is configured.',
      'Create an OAuth client at ' + params.spec.setupUrl + ' and paste its client ID into Trowser options.'
    );
  }

  const url = new URL(params.spec.authorizeUrl);
  const scopes = Array.from(new Set([...params.spec.scopes, ...(params.scopes ?? [])]));

  url.searchParams.set('client_id', params.clientId.trim());
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');

  return url.toString();
}

export interface ImplicitCallback {
  accessToken: string;
  expiresAt?: number;
  scopes: string[];
  state?: string;
}

/**
 * Parses the redirect URL returned by launchWebAuthFlow. Providers put the
 * token in the fragment; errors can arrive in either the fragment or the query.
 */
export function parseImplicitCallback(redirectUrl: string, expectedState: string, now = Date.now()): ImplicitCallback {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    throw new OAuthError('The sign-in redirect was malformed.');
  }

  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const query = url.searchParams;
  const read = (key: string): string | null => fragment.get(key) ?? query.get(key);

  const error = read('error');
  if (error) {
    const description = read('error_description');
    throw new OAuthError('Sign-in was refused: ' + error + (description ? ' (' + description + ')' : ''));
  }

  const returnedState = read('state');
  // A missing or mismatched state means the response cannot be trusted.
  if (!returnedState || returnedState !== expectedState) {
    throw new OAuthError('Sign-in state did not match. The response was discarded.');
  }

  const accessToken = read('access_token');
  if (!accessToken) throw new OAuthError('The provider did not return an access token.');

  const expiresIn = Number(read('expires_in'));
  const scope = read('scope') ?? '';

  return {
    accessToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    scopes: scope.split(/[\s+]/).filter(Boolean),
    state: returnedState
  };
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
}

export function parseDeviceCodeResponse(payload: unknown, now = Date.now()): DeviceCodeResponse {
  const data = asRecord(payload);
  const deviceCode = str(data.device_code);
  const userCode = str(data.user_code);
  const verificationUri = str(data.verification_uri) || str(data.verification_uri_complete);

  if (!deviceCode || !userCode || !verificationUri) {
    const error = str(data.error_description) || str(data.error);
    throw new OAuthError(
      error ? 'GitHub refused the device request: ' + error : 'GitHub returned an unexpected device code response.',
      'Enable "Device flow" on your OAuth app at https://github.com/settings/developers, or sign in with a personal access token instead.'
    );
  }

  const interval = Number(data.interval);
  const expiresIn = Number(data.expires_in);

  return {
    deviceCode,
    userCode,
    verificationUri,
    // GitHub asks for at least 5s between polls; go slightly slower to be safe.
    intervalMs: Math.max(Number.isFinite(interval) ? interval * 1000 : 5000, 5000),
    expiresAt: now + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 900_000)
  };
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; intervalMs: number }
  | { status: 'ok'; accessToken: string; scopes: string[] };

/** Interprets one device-token poll. Terminal failures throw. */
export function parseDevicePoll(payload: unknown, currentIntervalMs: number): DevicePollResult {
  const data = asRecord(payload);
  const accessToken = str(data.access_token);

  if (accessToken) {
    return { status: 'ok', accessToken, scopes: str(data.scope).split(/[\s,]+/).filter(Boolean) };
  }

  const error = str(data.error);

  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow_down', intervalMs: currentIntervalMs + 5000 };

  if (error === 'expired_token') throw new OAuthError('The device code expired before you approved it.', 'Start the sign-in again.');
  if (error === 'access_denied') throw new OAuthError('Sign-in was cancelled.');
  if (error === 'incorrect_client_credentials') {
    throw new OAuthError('GitHub rejected the client ID.', 'Check the client ID in Trowser options matches your OAuth app.');
  }

  throw new OAuthError(error ? 'GitHub sign-in failed: ' + (str(data.error_description) || error) : 'GitHub returned an unexpected response.');
}

/**
 * Validates the shape of a pasted token so an obvious paste error is caught
 * before a network round trip.
 */
export function looksLikeGitHubToken(token: string): boolean {
  const value = token.trim();
  if (/^gh[pousr]_[A-Za-z0-9]{36,}$/.test(value)) return true;
  // Classic 40-character hex tokens are still valid.
  return /^[a-f0-9]{40}$/i.test(value);
}

export function looksLikeHfToken(token: string): boolean {
  return /^hf_[A-Za-z0-9]{20,}$/.test(token.trim());
}

/** True when a stored token is at or near expiry. */
export function isExpired(expiresAt: number | undefined, now = Date.now(), skewMs = 60_000): boolean {
  if (!expiresAt) return false;
  return expiresAt - skewMs <= now;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
