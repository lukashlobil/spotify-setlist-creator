/**
 * Manifest V3 Service Worker:
 * Handles Spotify OAuth 2.0 PKCE authentication, token refresh, track matching,
 * manual search, and playlist creation via the Spotify Web API.
 */

import {
  buildAuthorizeUrl,
  generateCodeChallenge,
  generateRandomString,
} from './lib/pkce.js';
import {
  SPOTIFY_SCOPES,
  SEARCH_LIMIT,
  SpotifyClient,
  exchangeCodeForTokens,
  refreshAccessToken,
} from './lib/spotify.js';
import { isNonStudioTrack, simplifyTrack } from './lib/matcher.js';

const STORAGE_KEYS = {
  CLIENT_ID: 'spotifyClientId',
  TOKENS: 'spotifyTokens',
  USER: 'spotifyUser',
  RECENT_PLAYLISTS: 'recentPlaylists',
};

const MAX_RECENT_PLAYLISTS = 15;

let refreshInFlight = null;

function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(values) {
  return chrome.storage.local.set(values);
}

async function removeStorage(keys) {
  return chrome.storage.local.remove(keys);
}

async function getAuthState() {
  const data = await getStorage([
    STORAGE_KEYS.CLIENT_ID,
    STORAGE_KEYS.TOKENS,
    STORAGE_KEYS.USER,
    STORAGE_KEYS.RECENT_PLAYLISTS,
  ]);

  const tokens = data[STORAGE_KEYS.TOKENS] || null;
  const user = data[STORAGE_KEYS.USER] || null;
  const clientId = data[STORAGE_KEYS.CLIENT_ID] || '';
  const recentPlaylists = Array.isArray(data[STORAGE_KEYS.RECENT_PLAYLISTS])
    ? data[STORAGE_KEYS.RECENT_PLAYLISTS]
    : [];

  return {
    clientId,
    redirectUri: getRedirectUri(),
    isAuthenticated: Boolean(tokens?.accessToken && (tokens?.refreshToken || tokens?.expiresAt > Date.now())),
    user,
    recentPlaylists,
  };
}

async function ensureValidAccessToken({ forceRefresh = false } = {}) {
  const data = await getStorage([STORAGE_KEYS.CLIENT_ID, STORAGE_KEYS.TOKENS]);
  const clientId = data[STORAGE_KEYS.CLIENT_ID];
  const tokens = data[STORAGE_KEYS.TOKENS];

  if (!tokens?.accessToken) {
    return null;
  }

  const isExpired = !tokens.expiresAt || Date.now() >= tokens.expiresAt;
  if (!forceRefresh && !isExpired) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken || !clientId) {
    await removeStorage([STORAGE_KEYS.TOKENS, STORAGE_KEYS.USER]);
    return null;
  }

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const refreshed = await refreshAccessToken({
          clientId,
          refreshToken: tokens.refreshToken,
        });
        await setStorage({ [STORAGE_KEYS.TOKENS]: refreshed });
        return refreshed.accessToken;
      } catch {
        await removeStorage([STORAGE_KEYS.TOKENS, STORAGE_KEYS.USER]);
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }

  return refreshInFlight;
}

function createSpotifyClient() {
  return new SpotifyClient({
    getAccessToken: () => ensureValidAccessToken({ forceRefresh: false }),
    onUnauthorized: async () => {
      const refreshed = await ensureValidAccessToken({ forceRefresh: true });
      return Boolean(refreshed);
    },
  });
}

async function startAuthFlow() {
  const data = await getStorage([STORAGE_KEYS.CLIENT_ID]);
  const clientId = (data[STORAGE_KEYS.CLIENT_ID] || '').trim();
  if (!clientId) {
    throw new Error('Please enter and save your Spotify Client ID first.');
  }

  const redirectUri = getRedirectUri();
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(32);

  const authUrl = buildAuthorizeUrl({
    clientId,
    redirectUri,
    codeChallenge,
    state,
    scopes: SPOTIFY_SCOPES,
  });

  const callbackUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (redirectedTo) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!redirectedTo) {
          reject(new Error('Spotify authorization was cancelled.'));
          return;
        }
        resolve(redirectedTo);
      }
    );
  });

  const parsedCallback = new URL(callbackUrl);
  const error = parsedCallback.searchParams.get('error');
  if (error) {
    throw new Error(
      error === 'access_denied'
        ? 'Spotify authorization was denied.'
        : `Spotify authorization error: ${error}`
    );
  }

  const returnedState = parsedCallback.searchParams.get('state');
  if (returnedState !== state) {
    throw new Error('OAuth state mismatch. Please try connecting again.');
  }

  const code = parsedCallback.searchParams.get('code');
  if (!code) {
    throw new Error('Spotify did not return an authorization code.');
  }

  const tokens = await exchangeCodeForTokens({
    clientId,
    code,
    redirectUri,
    codeVerifier,
  });

  await setStorage({ [STORAGE_KEYS.TOKENS]: tokens });

  const client = createSpotifyClient();
  const user = await client.getCurrentUser();
  await setStorage({ [STORAGE_KEYS.USER]: user });

  return getAuthState();
}

async function logout() {
  await removeStorage([STORAGE_KEYS.TOKENS, STORAGE_KEYS.USER]);
  return getAuthState();
}

async function saveRecentPlaylist(entry) {
  const data = await getStorage([STORAGE_KEYS.RECENT_PLAYLISTS]);
  const existing = Array.isArray(data[STORAGE_KEYS.RECENT_PLAYLISTS])
    ? data[STORAGE_KEYS.RECENT_PLAYLISTS]
    : [];
  const next = [entry, ...existing.filter((p) => p.playlistId !== entry.playlistId)].slice(
    0,
    MAX_RECENT_PLAYLISTS
  );
  await setStorage({ [STORAGE_KEYS.RECENT_PLAYLISTS]: next });
  return next;
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'GET_AUTH_STATE': {
      const state = await getAuthState();
      if (state.isAuthenticated && !state.user) {
        try {
          const client = createSpotifyClient();
          const user = await client.getCurrentUser();
          await setStorage({ [STORAGE_KEYS.USER]: user });
          state.user = user;
        } catch {
          // Keep state as-is; next API call will refresh or prompt sign-in
        }
      }
      return { ok: true, data: state };
    }

    case 'SAVE_CLIENT_ID': {
      const clientId = String(message.clientId || '').trim();
      if (!clientId) {
        throw new Error('Client ID cannot be empty.');
      }
      if (!/^[a-f0-9]{32}$/i.test(clientId)) {
        throw new Error('Spotify Client IDs are 32-character hexadecimal strings.');
      }
      await setStorage({ [STORAGE_KEYS.CLIENT_ID]: clientId });
      return { ok: true, data: await getAuthState() };
    }

    case 'START_AUTH': {
      const state = await startAuthFlow();
      return { ok: true, data: state };
    }

    case 'LOGOUT': {
      const state = await logout();
      return { ok: true, data: state };
    }

    case 'MATCH_SONGS': {
      const { songs = [], artist = '', requestId = '' } = message;
      const client = createSpotifyClient();
      const tabId = sender?.tab?.id;

      const results = await client.matchSongs(songs, artist, {
        onProgress: ({ completed, total, item }) => {
          if (typeof tabId === 'number') {
            chrome.tabs
              .sendMessage(tabId, {
                type: 'MATCH_PROGRESS',
                requestId,
                completed,
                total,
                songId: item.songId,
                title: item.title,
              })
              .catch(() => {});
          }
        },
      });

      return { ok: true, data: { results } };
    }

    case 'SEARCH_TRACK_MANUAL': {
      const query = String(message.query || '').trim();
      if (!query) {
        return { ok: true, data: { tracks: [] } };
      }
      const client = createSpotifyClient();
      const rawTracks = await client.searchTracks(query, SEARCH_LIMIT);
      const studioTracks = rawTracks.filter((t) => !isNonStudioTrack(t));
      return {
        ok: true,
        data: { tracks: studioTracks.map((t) => ({ ...simplifyTrack(t), confidence: 100 })) },
      };
    }

    case 'CREATE_PLAYLIST': {
      const {
        name = 'Setlist.fm Playlist',
        description = '',
        isPublic = false,
        uris = [],
        sourceUrl = '',
        artist = '',
      } = message;

      if (!Array.isArray(uris) || uris.length === 0) {
        throw new Error('Select at least one matched track to create a playlist.');
      }

      const client = createSpotifyClient();
      const stored = await getStorage([STORAGE_KEYS.USER]);
      const userId = stored[STORAGE_KEYS.USER]?.id || '';

      const playlist = await client.createPlaylist({
        name,
        description,
        isPublic,
        userId,
      });

      await client.addItemsToPlaylist(playlist.id, uris);

      const playlistUrl =
        playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`;

      const result = {
        playlistId: playlist.id,
        name: playlist.name || name,
        url: playlistUrl,
        trackCount: uris.length,
        isPublic: Boolean(isPublic),
        artist,
        sourceUrl,
        createdAt: new Date().toISOString(),
      };

      await saveRecentPlaylist(result);

      return { ok: true, data: result };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((res) => sendResponse(res))
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err?.message || 'Unexpected error in background service worker.',
        status: err?.status || 0,
      });
    });
  return true;
});
