/**
 * Spotify Web API client (updated for February 2026 Web API endpoints & limits).
 *
 * Key 2026 compliance details:
 * - Search limit capped at <= 10 (`SEARCH_LIMIT = 10`)
 * - Create playlist via `POST /v1/me/playlists` (with fallback to `/v1/users/{id}/playlists`)
 * - Add items via `POST /v1/playlists/{id}/items` (with fallback to `/tracks`)
 * - Automatic 429 Retry-After handling and 401 access token refresh retry
 */

import { buildSearchQueries, rankCandidates } from './matcher.js';

export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-private',
];
export const SEARCH_LIMIT = 10;
export const MAX_ITEMS_PER_ADD = 100;

export class SpotifyApiError extends Error {
  constructor(message, { status = 0, code = '', details = null } = {}) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const defaultFetch = (...args) => globalThis.fetch(...args);

export async function exchangeCodeForTokens({
  clientId,
  code,
  redirectUri,
  codeVerifier,
  fetchImpl = defaultFetch,
}) {
  const response = await fetchImpl(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  const data = await safeJson(response);
  if (!response.ok || !data?.access_token) {
    throw new SpotifyApiError(
      data?.error_description || data?.error || `Token exchange failed (${response.status})`,
      { status: response.status, code: data?.error || 'token_exchange_failed', details: data }
    );
  }

  return normalizeTokenPayload(data);
}

export async function refreshAccessToken({
  clientId,
  refreshToken,
  fetchImpl = defaultFetch,
}) {
  const response = await fetchImpl(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const data = await safeJson(response);
  if (!response.ok || !data?.access_token) {
    throw new SpotifyApiError(
      data?.error_description || data?.error || `Token refresh failed (${response.status})`,
      { status: response.status, code: data?.error || 'token_refresh_failed', details: data }
    );
  }

  return normalizeTokenPayload(data, refreshToken);
}

function normalizeTokenPayload(data, fallbackRefreshToken = '') {
  const expiresInSec = Number(data.expires_in) || 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken,
    expiresAt: Date.now() + Math.max(expiresInSec - 60, 60) * 1000,
    scope: data.scope || '',
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Authenticated Spotify API client with automatic 401 refresh and 429 backoff.
 */
export class SpotifyClient {
  constructor({
    getAccessToken,
    onUnauthorized,
    fetchImpl = defaultFetch,
    sleepImpl = sleep,
    maxRetries = 3,
  }) {
    this.getAccessToken = getAccessToken;
    this.onUnauthorized = onUnauthorized;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
    this.maxRetries = maxRetries;
  }

  async request(path, { method = 'GET', body = null, _retriedAuth = false, _attempt = 0 } = {}) {
    const token = await this.getAccessToken();
    if (!token) {
      throw new SpotifyApiError('Not connected to Spotify. Please sign in first.', {
        status: 401,
        code: 'not_authenticated',
      });
    }

    const url = path.startsWith('http') ? path : `${SPOTIFY_API_BASE}${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
    };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchFn = this.fetchImpl;
    const response = await fetchFn(url, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401 && !_retriedAuth && this.onUnauthorized) {
      const refreshed = await this.onUnauthorized();
      if (refreshed) {
        return this.request(path, { method, body, _retriedAuth: true, _attempt });
      }
    }

    if (response.status === 429 && _attempt < this.maxRetries) {
      const retryAfterSec = Number(response.headers?.get?.('Retry-After')) || 1;
      const delayMs = Math.min(Math.max(retryAfterSec, 1) * 1000, 15000);
      const sleepFn = this.sleepImpl;
      await sleepFn(delayMs);
      return this.request(path, { method, body, _retriedAuth, _attempt: _attempt + 1 });
    }

    const data = await safeJson(response);
    if (!response.ok) {
      const msg =
        data?.error?.message ||
        data?.error_description ||
        `Spotify API error (${response.status})`;
      throw new SpotifyApiError(msg, {
        status: response.status,
        code: String(data?.error?.status || response.status),
        details: data,
      });
    }

    return data;
  }

  async getCurrentUser() {
    const profile = await this.request('/me');
    const avatarUrl = profile.images?.[0]?.url || '';
    return {
      id: profile.id,
      displayName: profile.display_name || profile.id,
      avatarUrl,
      product: profile.product || '',
      externalUrl: profile.external_urls?.spotify || '',
    };
  }

  async searchTracks(query, limit = SEARCH_LIMIT) {
    const clampedLimit = Math.min(Math.max(Number(limit) || SEARCH_LIMIT, 1), SEARCH_LIMIT);
    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: String(clampedLimit),
    });
    const data = await this.request(`/search?${params.toString()}`);
    return data?.tracks?.items || [];
  }

  /**
   * Finds the best studio Spotify track match + alternatives for a single setlist song.
   */
  async matchSong(song, mainArtist) {
    const queries = buildSearchQueries(song, mainArtist);
    const collected = [];

    for (const { query } of queries) {
      const items = await this.searchTracks(query, SEARCH_LIMIT);
      if (items.length > 0) {
        collected.push(...items);

        const provisional = rankCandidates(song, mainArtist, collected);
        if (provisional.bestMatch && provisional.bestMatch.confidence >= 82) {
          return provisional;
        }
      }
    }

    return rankCandidates(song, mainArtist, collected);
  }

  /**
   * Matches an array of setlist songs sequentially (friendly to Spotify rate limits),
   * optionally reporting progress after each track.
   */
  async matchSongs(songs, mainArtist, { onProgress = null } = {}) {
    const results = [];
    for (let i = 0; i < songs.length; i += 1) {
      const song = songs[i];
      let matchResult;
      try {
        matchResult = await this.matchSong(song, mainArtist);
      } catch (err) {
        if (err instanceof SpotifyApiError && err.status === 401) {
          throw err;
        }
        matchResult = { bestMatch: null, alternatives: [], error: err.message };
      }

      const item = {
        songId: song.id,
        title: song.title,
        section: song.section,
        isTape: song.isTape,
        note: song.note,
        ...matchResult,
      };
      results.push(item);

      if (onProgress) {
        onProgress({ completed: i + 1, total: songs.length, item });
      }
    }
    return results;
  }

  /**
   * Creates a playlist in the signed-in user's Spotify library.
   * Uses the 2026 `POST /v1/me/playlists` endpoint with fallback to `/v1/users/{id}/playlists`.
   */
  async createPlaylist({ name, description = '', isPublic = false, userId = '' }) {
    const payload = {
      name: (name || 'Setlist.fm Playlist').slice(0, 100),
      description: (description || '').slice(0, 300),
      public: Boolean(isPublic),
    };

    try {
      return await this.request('/me/playlists', {
        method: 'POST',
        body: payload,
      });
    } catch (err) {
      if (err instanceof SpotifyApiError && (err.status === 404 || err.status === 405)) {
        const resolvedUserId = userId || (await this.getCurrentUser()).id;
        return this.request(`/users/${encodeURIComponent(resolvedUserId)}/playlists`, {
          method: 'POST',
          body: payload,
        });
      }
      throw err;
    }
  }

  /**
   * Adds track URIs to a playlist in chunks of 100.
   * Uses the 2026 `POST /v1/playlists/{id}/items` endpoint with fallback to `/tracks`.
   */
  async addItemsToPlaylist(playlistId, uris) {
    const validUris = (uris || []).filter(Boolean);
    if (validUris.length === 0) return { added: 0 };

    const encodedId = encodeURIComponent(playlistId);
    let useLegacyTracks = false;

    for (let i = 0; i < validUris.length; i += MAX_ITEMS_PER_ADD) {
      const chunk = validUris.slice(i, i + MAX_ITEMS_PER_ADD);
      const endpoint = useLegacyTracks
        ? `/playlists/${encodedId}/tracks`
        : `/playlists/${encodedId}/items`;

      try {
        await this.request(endpoint, {
          method: 'POST',
          body: { uris: chunk },
        });
      } catch (err) {
        if (
          !useLegacyTracks &&
          err instanceof SpotifyApiError &&
          (err.status === 404 || err.status === 405)
        ) {
          useLegacyTracks = true;
          await this.request(`/playlists/${encodedId}/tracks`, {
            method: 'POST',
            body: { uris: chunk },
          });
        } else {
          throw err;
        }
      }
    }

    return { added: validUris.length };
  }
}
