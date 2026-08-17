/**
 * Sign-in runtime.
 *
 * Tokens live in chrome.storage.local, never in sync storage, and are never
 * written to the trace or any log. `describeAccount` is the only thing the UI
 * is given, so a token cannot leak through the view layer.
 */

import type { Account, AuthProviderId } from '../types';
import {
  OAuthError,
  PROVIDERS,
  buildAuthorizeUrl,
  isExpired,
  looksLikeGitHubToken,
  parseDeviceCodeResponse,
  parseDevicePoll,
  parseImplicitCallback,
  randomString,
  type DeviceCodeResponse
} from './oauth';

const ACCOUNTS_KEY = 'trowser.accounts.v1';
const TOKENS_KEY = 'trowser.tokens.v1';

interface StoredToken {
  accessToken: string;
  expiresAt?: number;
}

type AccountMap = Partial<Record<AuthProviderId, Account>>;
type TokenMap = Partial<Record<AuthProviderId, StoredToken>>;

export async function getAccounts(): Promise<AccountMap> {
  const stored = await chrome.storage.local.get(ACCOUNTS_KEY);
  const value = stored[ACCOUNTS_KEY];
  return value && typeof value === 'object' ? (value as AccountMap) : {};
}

export async function getAccount(provider: AuthProviderId): Promise<Account | undefined> {
  return (await getAccounts())[provider];
}

/**
 * Returns a usable access token, or undefined when signed out or expired.
 * Implicit-flow tokens cannot be refreshed without a server, so an expired
 * Google token means the user signs in again.
 */
export async function getAccessToken(provider: AuthProviderId): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(TOKENS_KEY);
  const tokens = (stored[TOKENS_KEY] ?? {}) as TokenMap;
  const token = tokens[provider];

  if (!token?.accessToken) return undefined;
  if (isExpired(token.expiresAt)) return undefined;
  return token.accessToken;
}

async function persist(provider: AuthProviderId, account: Account, token: StoredToken): Promise<void> {
  const [accounts, stored] = await Promise.all([getAccounts(), chrome.storage.local.get(TOKENS_KEY)]);
  const tokens = (stored[TOKENS_KEY] ?? {}) as TokenMap;

  await chrome.storage.local.set({
    [ACCOUNTS_KEY]: { ...accounts, [provider]: account },
    [TOKENS_KEY]: { ...tokens, [provider]: token }
  });
}

export async function signOut(provider: AuthProviderId): Promise<void> {
  const [accounts, stored] = await Promise.all([getAccounts(), chrome.storage.local.get(TOKENS_KEY)]);
  const tokens = (stored[TOKENS_KEY] ?? {}) as TokenMap;

  delete accounts[provider];
  delete tokens[provider];

  await chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts, [TOKENS_KEY]: tokens });
}

/** The redirect URL Chrome reserves for this extension. */
export function getRedirectUri(): string {
  return chrome.identity.getRedirectURL('oauth');
}

/* -------------------------------------------------------------------------- */
/* Google                                                                      */
/* -------------------------------------------------------------------------- */

export async function signInWithGoogle(clientId: string): Promise<Account> {
  const spec = PROVIDERS.google;
  const state = randomString(24);

  const authUrl = buildAuthorizeUrl({
    spec,
    clientId,
    redirectUri: getRedirectUri(),
    state
  });

  const redirectUrl = await launchWebAuthFlow(authUrl);
  const callback = parseImplicitCallback(redirectUrl, state);

  const profile = await fetchGoogleProfile(callback.accessToken);

  const account: Account = {
    provider: 'google',
    id: profile.sub,
    login: profile.email ?? profile.sub,
    name: profile.name,
    email: profile.email,
    avatarUrl: profile.picture,
    expiresAt: callback.expiresAt,
    scopes: callback.scopes.length ? callback.scopes : spec.scopes
  };

  await persist('google', account, { accessToken: callback.accessToken, expiresAt: callback.expiresAt });
  return account;
}

interface GoogleProfile {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: 'Bearer ' + accessToken }
  });

  if (!response.ok) {
    throw new OAuthError('Google rejected the access token (' + response.status + ').', 'Sign in again.');
  }

  const profile = (await response.json()) as GoogleProfile;
  if (!profile.sub) throw new OAuthError('Google returned an incomplete profile.');
  return profile;
}

/* -------------------------------------------------------------------------- */
/* GitHub                                                                      */
/* -------------------------------------------------------------------------- */

export interface DeviceFlowHandle {
  userCode: string;
  verificationUri: string;
  /** Resolves when the user approves, rejects on denial or timeout. */
  completed: Promise<Account>;
}

/**
 * Starts the GitHub device flow. The caller shows `userCode` and opens
 * `verificationUri`, then awaits `completed`.
 */
export async function startGitHubDeviceFlow(clientId: string, signal?: AbortSignal): Promise<DeviceFlowHandle> {
  if (!clientId.trim()) {
    throw new OAuthError(
      'No GitHub client ID is configured.',
      'Create an OAuth app at https://github.com/settings/developers with "Device flow" enabled, then paste its client ID into options. ' +
        'Alternatively, sign in with a personal access token.'
    );
  }

  const device = parseDeviceCodeResponse(
    await postForm(PROVIDERS.github.deviceCodeUrl as string, {
      client_id: clientId.trim(),
      scope: PROVIDERS.github.scopes.join(' ')
    })
  );

  return {
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    completed: pollForGitHubToken(clientId.trim(), device, signal)
  };
}

async function pollForGitHubToken(clientId: string, device: DeviceCodeResponse, signal?: AbortSignal): Promise<Account> {
  let intervalMs = device.intervalMs;

  for (;;) {
    if (signal?.aborted) throw new DOMException('Sign-in cancelled.', 'AbortError');
    if (Date.now() > device.expiresAt) {
      throw new OAuthError('The device code expired before you approved it.', 'Start the sign-in again.');
    }

    await delay(intervalMs, signal);

    const result = parseDevicePoll(
      await postForm(PROVIDERS.github.deviceTokenUrl as string, {
        client_id: clientId,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }),
      intervalMs
    );

    if (result.status === 'slow_down') {
      intervalMs = result.intervalMs;
      continue;
    }
    if (result.status === 'pending') continue;

    return finishGitHubSignIn(result.accessToken, result.scopes);
  }
}

/** Signs in with a pasted personal access token. Always works, no OAuth app. */
export async function signInWithGitHubToken(token: string): Promise<Account> {
  const trimmed = token.trim();

  if (!looksLikeGitHubToken(trimmed)) {
    throw new OAuthError(
      'That does not look like a GitHub token.',
      'Create one at https://github.com/settings/tokens with the "gist" scope. It starts with ghp_ or github_pat_.'
    );
  }

  return finishGitHubSignIn(trimmed, ['gist', 'read:user']);
}

async function finishGitHubSignIn(accessToken: string, scopes: string[]): Promise<Account> {
  const response = await fetch('https://api.github.com/user', {
    headers: { authorization: 'Bearer ' + accessToken, accept: 'application/vnd.github+json' }
  });

  if (!response.ok) {
    throw new OAuthError(
      'GitHub rejected the token (' + response.status + ').',
      'Check the token has not expired and includes the "gist" scope.'
    );
  }

  const profile = (await response.json()) as { id?: number; login?: string; name?: string; email?: string; avatar_url?: string };
  if (!profile.login) throw new OAuthError('GitHub returned an incomplete profile.');

  const account: Account = {
    provider: 'github',
    id: String(profile.id ?? profile.login),
    login: profile.login,
    name: profile.name ?? undefined,
    email: profile.email ?? undefined,
    avatarUrl: profile.avatar_url ?? undefined,
    scopes
  };

  await persist('github', account, { accessToken });
  return account;
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                    */
/* -------------------------------------------------------------------------- */

async function launchWebAuthFlow(url: string): Promise<string> {
  try {
    const redirectUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    if (!redirectUrl) throw new OAuthError('Sign-in window closed before completing.');
    return redirectUrl;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new OAuthError('Sign-in failed: ' + message, 'Check the redirect URI registered on your OAuth client is:\n' + getRedirectUri());
  }
}

async function postForm(url: string, fields: Record<string, string>): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    });
  } catch {
    throw new OAuthError(
      'Could not reach ' + safeHost(url) + ' from the browser.',
      'This network or browser blocked the request. Sign in with a personal access token instead.'
    );
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    // GitHub falls back to form encoding when Accept is not honoured.
    return Object.fromEntries(new URLSearchParams(text));
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Sign-in cancelled.', 'AbortError'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The only account projection the UI is allowed to render. */
export function describeAccount(account: Account | undefined): string {
  if (!account) return 'Not signed in';
  const who = account.name || account.login;
  return who + ' (' + PROVIDERS[account.provider].label + ')';
}
