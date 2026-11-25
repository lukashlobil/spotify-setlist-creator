import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_LIMIT,
  SpotifyClient,
  exchangeCodeForTokens,
} from '../src/lib/spotify.js';
import { generateCodeChallenge, generateRandomString, buildAuthorizeUrl } from '../src/lib/pkce.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headerMap.get(name.toLowerCase()) ?? null,
    },
    async json() {
      return body;
    },
  };
}

test('PKCE helpers generate RFC 7636 S256 challenge and valid authorize URL', async () => {
  const verifier = generateRandomString(64);
  assert.equal(verifier.length, 64);

  const challenge = await generateCodeChallenge(verifier);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(challenge));

  const url = buildAuthorizeUrl({
    clientId: '0123456789abcdef0123456789abcdef',
    redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
    codeChallenge: challenge,
    state: 'test-state',
    scopes: ['playlist-modify-private', 'playlist-modify-public'],
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://accounts.spotify.com');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('code_challenge'), challenge);
  assert.equal(parsed.searchParams.get('state'), 'test-state');
});

test('SpotifyClient uses 2026 /v1/me/playlists, /v1/playlists/{id}/items, and search limit <= 10', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });

    if (url.includes('/v1/search')) {
      const limit = Number(new URL(url).searchParams.get('limit'));
      assert.ok(limit <= SEARCH_LIMIT, `search limit ${limit} exceeded ${SEARCH_LIMIT}`);
      return jsonResponse({
        tracks: {
          items: [
            {
              id: 'abc',
              uri: 'spotify:track:abc',
              name: 'Pleistocene',
              artists: [{ name: 'The Ocean' }],
              album: { name: 'Phanerozoic II', images: [] },
              popularity: 50,
            },
          ],
        },
      });
    }

    if (url.endsWith('/v1/me/playlists') && init.method === 'POST') {
      return jsonResponse({
        id: 'pl_123',
        name: 'The Ocean — Poble Espanyol',
        external_urls: { spotify: 'https://open.spotify.com/playlist/pl_123' },
      });
    }

    if (url.endsWith('/v1/playlists/pl_123/items') && init.method === 'POST') {
      return jsonResponse({ snapshot_id: 'snap_1' });
    }

    throw new Error(`Unexpected request: ${init.method} ${url}`);
  };

  const client = new SpotifyClient({
    getAccessToken: async () => 'token-1',
    fetchImpl,
  });

  const tracks = await client.searchTracks('track:"Pleistocene" artist:"The Ocean"', 50);
  assert.equal(tracks.length, 1);

  const playlist = await client.createPlaylist({
    name: 'The Ocean — Poble Espanyol',
    description: 'From setlist.fm',
    isPublic: false,
  });
  assert.equal(playlist.id, 'pl_123');

  const added = await client.addItemsToPlaylist(playlist.id, ['spotify:track:abc']);
  assert.equal(added.added, 1);

  assert.equal(calls[1].url, 'https://api.spotify.com/v1/me/playlists');
  assert.equal(calls[2].url, 'https://api.spotify.com/v1/playlists/pl_123/items');
  assert.deepEqual(calls[2].body, { uris: ['spotify:track:abc'] });
});

test('SpotifyClient refreshes token on 401 and retries on 429 Retry-After', async () => {
  let token = 'expired-token';
  let attempt = 0;
  const sleeps = [];

  const fetchImpl = async (url, init = {}) => {
    attempt += 1;
    if (attempt === 1) {
      assert.equal(init.headers.Authorization, 'Bearer expired-token');
      return jsonResponse({ error: { status: 401, message: 'Expired' } }, { status: 401 });
    }
    if (attempt === 2) {
      assert.equal(init.headers.Authorization, 'Bearer fresh-token');
      return jsonResponse(
        { error: { status: 429, message: 'Rate limited' } },
        { status: 429, headers: { 'Retry-After': '2' } }
      );
    }
    return jsonResponse({ id: 'user_1', display_name: 'Alice', images: [] });
  };

  const client = new SpotifyClient({
    getAccessToken: async () => token,
    onUnauthorized: async () => {
      token = 'fresh-token';
      return true;
    },
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
  });

  const user = await client.getCurrentUser();
  assert.equal(user.id, 'user_1');
  assert.equal(user.displayName, 'Alice');
  assert.equal(attempt, 3);
  assert.deepEqual(sleeps, [2000]);
});

test('exchangeCodeForTokens parses token payload cleanly', async () => {
  const fetchImpl = async () =>
    jsonResponse({
      access_token: 'acc_123',
      refresh_token: 'ref_456',
      expires_in: 3600,
      scope: 'playlist-modify-private',
    });

  const tokens = await exchangeCodeForTokens({
    clientId: 'client_1',
    code: 'code_1',
    redirectUri: 'https://ext.chromiumapp.org/',
    codeVerifier: 'verifier_1',
    fetchImpl,
  });

  assert.equal(tokens.accessToken, 'acc_123');
  assert.equal(tokens.refreshToken, 'ref_456');
  assert.ok(tokens.expiresAt > Date.now());
});

test('SpotifyClient invokes fetch without binding `this` to the client instance (WorkerGlobalScope safe)', async () => {
  function strictFetch() {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
    }
    return Promise.resolve(jsonResponse({ id: 'u1', display_name: 'Tester', images: [] }));
  }

  const client = new SpotifyClient({
    getAccessToken: async () => 'tok',
    fetchImpl: strictFetch,
  });

  const user = await client.getCurrentUser();
  assert.equal(user.id, 'u1');
});
