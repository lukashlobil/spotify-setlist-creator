/**
 * Content script injected on setlist.fm/setlist/* pages.
 * Parses the concert setlist from the live DOM, renders a non-intrusive Shadow DOM
 * CTA banner above the setlist, and opens a full interactive slide-over drawer for
 * Spotify OAuth sign-in, track matching/swapping, and playlist creation.
 */

(async function initSetlistToSpotify() {
  if (window.__setlistToSpotifyLoaded) return;
  window.__setlistToSpotifyLoaded = true;

  const { parseSetlistDocument } = await import(chrome.runtime.getURL('src/lib/parser.js'));

  const state = {
    setlist: parseSetlistDocument(document, window.location.href),
    auth: null,
    drawerOpen: false,
    showSetup: false,
    playlistName: '',
    playlistDescription: '',
    isPublic: false,
    includeTapes: false,
    songs: [], // enriched with { ...song, bestMatch, alternatives, selectedTrack, matchAttempted, manualQuery, manualResults, searchingManual }
    matching: false,
    matchProgress: { completed: 0, total: 0, currentTitle: '' },
    creating: false,
    createdPlaylist: null,
    error: '',
    statusMessage: '',
    activeRequestId: '',
  };

  function syncSongsFromSetlist(setlist) {
    state.setlist = setlist;
    state.playlistName = setlist.suggestedPlaylistName;
    state.playlistDescription = setlist.suggestedDescription;
    state.songs = setlist.songs.map((s) => ({
      ...s,
      bestMatch: null,
      alternatives: [],
      selectedTrack: null,
      matchAttempted: false,
      manualOpen: false,
      manualQuery: `${s.title} ${setlist.artist}`.trim(),
      manualResults: [],
      searchingManual: false,
    }));
  }

  syncSongsFromSetlist(state.setlist);

  // --- Messaging helpers ---
  function sendBg(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('No response from extension background service.'));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || 'Operation failed.'));
          return;
        }
        resolve(response.data);
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_PAGE_SETLIST') {
      const fresh = parseSetlistDocument(document, window.location.href);
      sendResponse({ ok: true, data: fresh });
      return false;
    }

    if (message?.type === 'OPEN_DRAWER') {
      openDrawer();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'MATCH_PROGRESS' && message.requestId === state.activeRequestId) {
      state.matchProgress = {
        completed: message.completed,
        total: message.total,
        currentTitle: message.title || '',
      };
      renderDrawer();
    }
    return false;
  });

  // --- HTML escaping ---
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const SPOTIFY_ICON_SVG = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M12 1.5C6.21 1.5 1.5 6.21 1.5 12S6.21 22.5 12 22.5 22.5 17.79 22.5 12 17.79 1.5 12 1.5zm4.82 15.14a.75.75 0 0 1-1.03.25c-2.82-1.72-6.37-2.11-10.55-1.15a.75.75 0 1 1-.33-1.46c4.57-1.05 8.49-.6 11.66 1.33.35.22.46.68.25 1.03zm1.29-2.86a.94.94 0 0 1-1.29.31c-3.23-1.98-8.15-2.56-11.97-1.4a.94.94 0 0 1-.55-1.8c4.36-1.32 9.78-.68 13.5 1.6.44.27.58.85.31 1.29zm.11-2.98c-3.87-2.3-10.26-2.51-13.96-1.39a1.12 1.12 0 1 1-.65-2.15c4.25-1.29 11.31-1.04 15.76 1.6a1.12 1.12 0 0 1-1.15 1.94z"/>
    </svg>
  `;

  // --- Inline Banner ---
  const bannerHost = document.createElement('div');
  bannerHost.id = 's2s-banner-host';
  const bannerShadow = bannerHost.attachShadow({ mode: 'open' });

  function mountBanner() {
    if (state.songs.length === 0) return;

    const target =
      document.querySelector('.setlistList') ||
      document.querySelector('.setlistContent') ||
      document.querySelector('.infoContainer');

    const nonTapeCount = state.songs.filter((s) => !s.isTape).length;
    const tapeCount = state.songs.length - nonTapeCount;
    const subtitle = [
      state.setlist.artist || 'Concert Setlist',
      `${nonTapeCount} ${nonTapeCount === 1 ? 'song' : 'songs'}${tapeCount > 0 ? ` (+${tapeCount} tape)` : ''}`,
    ].join(' • ');

    bannerShadow.innerHTML = `
      <style>
        :host {
          display: block;
          margin: 12px 0 16px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .s2s-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          padding: 12px 16px;
          border-radius: 10px;
          background: linear-gradient(135deg, #121518 0%, #18231c 100%);
          border: 1px solid rgba(29, 185, 84, 0.35);
          color: #f3f5f7;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
        }
        .s2s-left {
          display: flex;
          align-items: center;
          gap: 11px;
          min-width: 0;
        }
        .s2s-logo {
          color: #1db954;
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }
        .s2s-meta {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .s2s-title {
          font-size: 14px;
          font-weight: 700;
          color: #ffffff;
          line-height: 1.25;
        }
        .s2s-sub {
          font-size: 12px;
          color: #b4c0c9;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .s2s-btn {
          appearance: none;
          border: none;
          border-radius: 999px;
          background: #1db954;
          color: #08120b;
          font-size: 13px;
          font-weight: 700;
          padding: 9px 18px;
          cursor: pointer;
          transition: transform 0.12s ease, background 0.12s ease;
          white-space: nowrap;
        }
        .s2s-btn:hover {
          background: #1ed760;
          transform: translateY(-1px);
        }
        .s2s-btn:active {
          transform: translateY(0);
        }
      </style>
      <div class="s2s-banner">
        <div class="s2s-left">
          <div class="s2s-logo">${SPOTIFY_ICON_SVG}</div>
          <div class="s2s-meta">
            <div class="s2s-title">Create a Spotify Playlist from this Setlist</div>
            <div class="s2s-sub">${esc(subtitle)}</div>
          </div>
        </div>
        <button class="s2s-btn" id="s2s-open-btn" type="button">Create Spotify Playlist</button>
      </div>
    `;

    bannerShadow.getElementById('s2s-open-btn').addEventListener('click', () => {
      openDrawer();
    });

    if (target && target.parentElement) {
      target.parentElement.insertBefore(bannerHost, target);
    } else {
      bannerHost.style.position = 'fixed';
      bannerHost.style.bottom = '16px';
      bannerHost.style.right = '16px';
      bannerHost.style.zIndex = '2147483640';
      document.body.appendChild(bannerHost);
    }
  }

  // --- Drawer Host ---
  const drawerHost = document.createElement('div');
  drawerHost.id = 's2s-drawer-host';
  const drawerShadow = drawerHost.attachShadow({ mode: 'open' });
  document.body.appendChild(drawerHost);

  async function refreshAuth() {
    try {
      state.auth = await sendBg({ type: 'GET_AUTH_STATE' });
      state.showSetup = !state.auth.clientId || !state.auth.isAuthenticated;
    } catch (err) {
      state.error = err.message;
    }
  }

  async function openDrawer() {
    state.drawerOpen = true;
    state.error = '';
    state.statusMessage = '';
    renderDrawer();

    await refreshAuth();
    renderDrawer();

    // Auto-match songs the first time drawer opens while signed in
    const anyAttempted = state.songs.some((s) => s.matchAttempted);
    if (state.auth?.isAuthenticated && !anyAttempted && !state.matching && state.songs.length > 0) {
      runMatchSongs();
    }
  }

  function closeDrawer() {
    state.drawerOpen = false;
    renderDrawer();
  }

  async function runMatchSongs() {
    const songsToMatch = state.songs.filter((s) => s.selected || state.includeTapes || !s.isTape);
    if (songsToMatch.length === 0) {
      state.error = 'No songs selected to match.';
      renderDrawer();
      return;
    }

    state.matching = true;
    state.error = '';
    state.createdPlaylist = null;
    state.activeRequestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.matchProgress = { completed: 0, total: songsToMatch.length, currentTitle: songsToMatch[0]?.title || '' };
    renderDrawer();

    try {
      const { results } = await sendBg({
        type: 'MATCH_SONGS',
        requestId: state.activeRequestId,
        songs: songsToMatch.map((s) => ({
          id: s.id,
          title: s.title,
          section: s.section,
          isTape: s.isTape,
          note: s.note,
        })),
        artist: state.setlist.artist,
      });

      const byId = new Map(results.map((r) => [r.songId, r]));
      for (const song of state.songs) {
        const res = byId.get(song.id);
        if (!res) continue;
        song.bestMatch = res.bestMatch || null;
        song.alternatives = res.alternatives || [];
        song.selectedTrack = res.bestMatch || null;
        song.matchAttempted = true;
      }
    } catch (err) {
      state.error = err.message;
      if (/sign in|authenticated|401/i.test(err.message)) {
        await refreshAuth();
      }
    } finally {
      state.matching = false;
      renderDrawer();
    }
  }

  async function runManualSearch(songId, query) {
    const song = state.songs.find((s) => s.id === songId);
    if (!song) return;

    song.manualQuery = query;
    song.searchingManual = true;
    renderDrawer();

    try {
      const { tracks } = await sendBg({ type: 'SEARCH_TRACK_MANUAL', query });
      song.manualResults = tracks || [];
    } catch (err) {
      state.error = err.message;
    } finally {
      song.searchingManual = false;
      renderDrawer();
    }
  }

  async function runCreatePlaylist() {
    const selectedMatched = state.songs.filter((s) => s.selected && s.selectedTrack?.uri);
    if (selectedMatched.length === 0) {
      state.error = 'Select at least one matched track before creating the playlist.';
      renderDrawer();
      return;
    }

    state.creating = true;
    state.error = '';
    renderDrawer();

    try {
      const result = await sendBg({
        type: 'CREATE_PLAYLIST',
        name: state.playlistName.trim() || state.setlist.suggestedPlaylistName,
        description: state.playlistDescription.trim(),
        isPublic: state.isPublic,
        uris: selectedMatched.map((s) => s.selectedTrack.uri),
        sourceUrl: state.setlist.url,
        artist: state.setlist.artist,
      });
      state.createdPlaylist = result;
    } catch (err) {
      state.error = err.message;
    } finally {
      state.creating = false;
      renderDrawer();
    }
  }

  function renderConfidenceBadge(track) {
    if (!track) {
      return '<span class="badge badge-miss">Not found</span>';
    }
    const conf = track.confidence ?? 100;
    if (conf >= 80) {
      return `<span class="badge badge-good">${conf}% match</span>`;
    }
    if (conf >= 55) {
      return `<span class="badge badge-warn">${conf}% match</span>`;
    }
    return `<span class="badge badge-miss">${conf}% match</span>`;
  }

  function renderSetupSection() {
    const redirectUri = state.auth?.redirectUri || '';
    const clientId = state.auth?.clientId || '';
    const isConnected = Boolean(state.auth?.isAuthenticated);

    return `
      <div class="card">
        <div class="section-heading">Connect Your Spotify Account</div>
        <p class="muted">
          This extension uses Spotify OAuth 2.0 PKCE directly from your browser — no external server or backend required.
        </p>

        <ol class="steps">
          <li>Open the <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer">Spotify Developer Dashboard</a> and click <strong>Create app</strong>.</li>
          <li>Under <strong>Redirect URIs</strong>, paste this exact URL, click <strong>Add</strong>, select <strong>Web API</strong>, and save:</li>
        </ol>

        <div class="copy-row">
          <input type="text" readonly class="input mono" id="s2s-redirect-uri" value="${esc(redirectUri)}" />
          <button type="button" class="btn btn-secondary btn-sm" id="s2s-copy-redirect">Copy</button>
        </div>

        <label class="field-label" for="s2s-client-id">Spotify Client ID</label>
        <div class="copy-row">
          <input
            type="text"
            class="input mono"
            id="s2s-client-id"
            placeholder="Paste 32-character Client ID"
            value="${esc(clientId)}"
          />
          <button type="button" class="btn btn-secondary btn-sm" id="s2s-save-client-id">Save</button>
        </div>

        <div class="setup-actions">
          <button
            type="button"
            class="btn btn-primary"
            id="s2s-connect-btn"
            ${!clientId ? 'disabled' : ''}
          >
            ${SPOTIFY_ICON_SVG}
            <span>${isConnected ? 'Reconnect Spotify' : 'Sign in with Spotify'}</span>
          </button>
          ${isConnected ? '<button type="button" class="btn btn-ghost" id="s2s-back-builder">Back to Setlist</button>' : ''}
        </div>
      </div>
    `;
  }

  function renderSuccessSection() {
    const p = state.createdPlaylist;
    return `
      <div class="card success-card">
        <div class="success-icon">✓</div>
        <div class="success-title">Playlist Created!</div>
        <div class="success-name">${esc(p.name)}</div>
        <div class="muted">${p.trackCount} ${p.trackCount === 1 ? 'track' : 'tracks'} added to your Spotify library (${p.isPublic ? 'Public' : 'Private'}).</div>
        <div class="success-actions">
          <a class="btn btn-primary" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">
            Open in Spotify
          </a>
          <button type="button" class="btn btn-secondary" id="s2s-copy-playlist-url">
            Copy Playlist Link
          </button>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="s2s-create-another" style="margin-top: 10px;">
          Back to Setlist Editor
        </button>
      </div>
    `;
  }

  function renderBuilderSection() {
    const hasTapes = state.songs.some((s) => s.isTape);
    const selectedSongs = state.songs.filter((s) => s.selected);
    const readyCount = selectedSongs.filter((s) => Boolean(s.selectedTrack?.uri)).length;
    const unmatchedCount = selectedSongs.filter((s) => s.matchAttempted && !s.selectedTrack).length;

    const progressPct =
      state.matchProgress.total > 0
        ? Math.round((state.matchProgress.completed / state.matchProgress.total) * 100)
        : 0;

    let lastSection = '';
    const songRowsHtml = state.songs
      .map((song) => {
        let sectionHeader = '';
        if (song.section && song.section !== lastSection) {
          lastSection = song.section;
          sectionHeader = `<div class="set-divider">${esc(song.section)}</div>`;
        }

        const track = song.selectedTrack;
        const altOptions = song.alternatives
          .map(
            (alt) => `
              <option value="${esc(alt.uri)}" ${track?.uri === alt.uri ? 'selected' : ''}>
                ${esc(alt.name)} — ${esc(alt.artists)} (${alt.confidence}%)
              </option>
            `
          )
          .join('');

        const manualResultsHtml = song.manualOpen
          ? `
            <div class="manual-box">
              <div class="copy-row">
                <input
                  type="text"
                  class="input input-sm manual-input"
                  data-song-id="${esc(song.id)}"
                  value="${esc(song.manualQuery)}"
                  placeholder="Search Spotify..."
                />
                <button
                  type="button"
                  class="btn btn-secondary btn-sm manual-search-btn"
                  data-song-id="${esc(song.id)}"
                  ${song.searchingManual ? 'disabled' : ''}
                >
                  ${song.searchingManual ? '...' : 'Go'}
                </button>
              </div>
              ${
                song.manualResults.length > 0
                  ? `<div class="manual-results">
                      ${song.manualResults
                        .slice(0, 5)
                        .map(
                          (t, idx) => `
                          <button
                            type="button"
                            class="manual-pick"
                            data-song-id="${esc(song.id)}"
                            data-pick-idx="${idx}"
                          >
                            ${t.imageUrl ? `<img src="${esc(t.imageUrl)}" alt="" class="mini-art" />` : '<div class="mini-art placeholder"></div>'}
                            <span class="manual-pick-text">
                              <strong>${esc(t.name)}</strong>
                              <span>${esc(t.artists)}${t.album ? ` • ${esc(t.album)}` : ''}</span>
                            </span>
                          </button>
                        `
                        )
                        .join('')}
                    </div>`
                  : ''
              }
            </div>
          `
          : '';

        return `
          ${sectionHeader}
          <div class="song-row ${song.selected ? '' : 'dimmed'}">
            <div class="song-top">
              <label class="song-check">
                <input
                  type="checkbox"
                  class="song-checkbox"
                  data-song-id="${esc(song.id)}"
                  ${song.selected ? 'checked' : ''}
                />
                <span class="song-title">${esc(song.title)}</span>
              </label>
              <div class="song-tags">
                ${song.isTape ? '<span class="tag tag-tape">Tape</span>' : ''}
                ${song.matchAttempted ? renderConfidenceBadge(track) : ''}
              </div>
            </div>

            ${
              track
                ? `<div class="match-line">
                    ${track.imageUrl ? `<img src="${esc(track.imageUrl)}" alt="" class="art" />` : '<div class="art placeholder"></div>'}
                    <div class="match-info">
                      <div class="match-name">${esc(track.name)}</div>
                      <div class="match-artist">${esc(track.artists)}${track.album ? ` • ${esc(track.album)}` : ''}</div>
                    </div>
                    <button
                      type="button"
                      class="icon-btn toggle-manual-btn"
                      data-song-id="${esc(song.id)}"
                      title="Search a different Spotify track"
                    >
                      Search
                    </button>
                  </div>`
                : song.matchAttempted
                ? `<div class="match-line miss-line">
                    <span class="muted">No automatic match found on Spotify.</span>
                    <button
                      type="button"
                      class="icon-btn toggle-manual-btn"
                      data-song-id="${esc(song.id)}"
                    >
                      Search manually
                    </button>
                  </div>`
                : ''
            }

            ${
              song.alternatives.length > 1
                ? `<select class="alt-select" data-song-id="${esc(song.id)}" aria-label="Choose alternative match">
                    ${altOptions}
                  </select>`
                : ''
            }

            ${manualResultsHtml}
          </div>
        `;
      })
      .join('');

    return `
      <div class="user-bar">
        <div class="user-info">
          ${
            state.auth?.user?.avatarUrl
              ? `<img src="${esc(state.auth.user.avatarUrl)}" alt="" class="avatar" />`
              : '<div class="avatar placeholder">♪</div>'
          }
          <div>
            <div class="user-name">${esc(state.auth?.user?.displayName || 'Spotify User')}</div>
            <div class="muted small">Connected to Spotify</div>
          </div>
        </div>
        <div class="user-actions">
          <button type="button" class="btn btn-ghost btn-xs" id="s2s-open-setup">Settings</button>
          <button type="button" class="btn btn-ghost btn-xs" id="s2s-logout">Sign out</button>
        </div>
      </div>

      <div class="card">
        <label class="field-label" for="s2s-playlist-name">Playlist Name</label>
        <input
          type="text"
          class="input"
          id="s2s-playlist-name"
          maxlength="100"
          value="${esc(state.playlistName)}"
        />

        <label class="field-label" for="s2s-playlist-desc">Description</label>
        <input
          type="text"
          class="input"
          id="s2s-playlist-desc"
          maxlength="300"
          value="${esc(state.playlistDescription)}"
        />

        <div class="toggle-grid">
          <label class="toggle-item">
            <input type="checkbox" id="s2s-public-toggle" ${state.isPublic ? 'checked' : ''} />
            <span>Make playlist public</span>
          </label>
          ${
            hasTapes
              ? `<label class="toggle-item">
                  <input type="checkbox" id="s2s-tapes-toggle" ${state.includeTapes ? 'checked' : ''} />
                  <span>Include tape / intro tracks</span>
                </label>`
              : ''
          }
        </div>
      </div>

      ${
        state.matching
          ? `<div class="progress-card">
              <div class="progress-top">
                <span>Matching songs on Spotify...</span>
                <span>${state.matchProgress.completed} / ${state.matchProgress.total}</span>
              </div>
              <div class="progress-track">
                <div class="progress-fill" style="width: ${progressPct}%"></div>
              </div>
              <div class="muted small truncate">${esc(state.matchProgress.currentTitle)}</div>
            </div>`
          : ''
      }

      <div class="list-toolbar">
        <div class="muted small">
          <strong>${readyCount}</strong> of ${selectedSongs.length} selected matched${unmatchedCount > 0 ? ` • ${unmatchedCount} unmatched` : ''}
        </div>
        <div class="toolbar-btns">
          <button type="button" class="btn btn-secondary btn-xs" id="s2s-rematch-btn" ${state.matching ? 'disabled' : ''}>
            ${state.matching ? 'Matching...' : 'Re-match Tracks'}
          </button>
        </div>
      </div>

      <div class="song-list">
        ${songRowsHtml}
      </div>
    `;
  }

  function renderDrawer() {
    if (!state.drawerOpen) {
      drawerShadow.innerHTML = '';
      return;
    }

    const selectedReadyCount = state.songs.filter(
      (s) => s.selected && Boolean(s.selectedTrack?.uri)
    ).length;

    const showBuilder =
      state.auth?.isAuthenticated && !state.showSetup && !state.createdPlaylist;

    drawerShadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .backdrop {
          position: fixed;
          inset: 0;
          background: rgba(5, 8, 12, 0.62);
          backdrop-filter: blur(2px);
          z-index: 2147483645;
          display: flex;
          justify-content: flex-end;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .drawer {
          width: min(460px, 100vw);
          height: 100vh;
          background: #101418;
          color: #f2f5f8;
          display: flex;
          flex-direction: column;
          box-shadow: -8px 0 36px rgba(0, 0, 0, 0.48);
          border-left: 1px solid #232b33;
        }
        .header {
          padding: 16px 18px;
          border-bottom: 1px solid #202730;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          background: #13191f;
        }
        .header-title {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 16px;
          font-weight: 700;
          color: #ffffff;
        }
        .header-title svg { color: #1db954; }
        .close-btn {
          background: transparent;
          border: 1px solid #2b3440;
          color: #c7d1db;
          width: 30px;
          height: 30px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
        }
        .close-btn:hover { background: #1e262f; color: #fff; }
        .body {
          flex: 1;
          overflow-y: auto;
          padding: 16px 18px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .footer {
          padding: 14px 18px;
          border-top: 1px solid #202730;
          background: #13191f;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .card {
          background: #161c22;
          border: 1px solid #232c35;
          border-radius: 10px;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .section-heading { font-size: 15px; font-weight: 700; color: #fff; }
        .muted { color: #96a4b2; font-size: 13px; margin: 0; line-height: 1.45; }
        .small { font-size: 12px; }
        .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .steps {
          margin: 0;
          padding-left: 18px;
          color: #d2dce5;
          font-size: 13px;
          line-height: 1.5;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .steps a { color: #1ed760; }
        .field-label {
          font-size: 12px;
          font-weight: 600;
          color: #b4c1ce;
          margin-top: 4px;
        }
        .input {
          width: 100%;
          background: #0d1115;
          border: 1px solid #2b3540;
          border-radius: 8px;
          color: #f3f6f9;
          padding: 8px 10px;
          font-size: 13px;
          outline: none;
        }
        .input:focus { border-color: #1db954; }
        .input-sm { padding: 6px 8px; font-size: 12px; }
        .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
        .copy-row { display: flex; gap: 8px; align-items: center; }
        .btn {
          appearance: none;
          border: none;
          border-radius: 999px;
          font-weight: 700;
          font-size: 13px;
          padding: 9px 16px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          text-decoration: none;
          transition: background 0.12s ease, opacity 0.12s ease;
        }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .btn-primary { background: #1db954; color: #07130b; }
        .btn-primary:hover:not(:disabled) { background: #1ed760; }
        .btn-secondary { background: #232d37; color: #eef3f7; border-radius: 8px; }
        .btn-secondary:hover:not(:disabled) { background: #2d3946; }
        .btn-ghost { background: transparent; color: #aebbc7; border-radius: 8px; }
        .btn-ghost:hover:not(:disabled) { background: #1d252e; color: #fff; }
        .btn-sm { padding: 7px 12px; font-size: 12px; }
        .btn-xs { padding: 5px 10px; font-size: 12px; }
        .setup-actions { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
        .alert {
          padding: 10px 12px;
          border-radius: 8px;
          font-size: 13px;
          line-height: 1.4;
        }
        .alert-error { background: rgba(235, 87, 87, 0.14); border: 1px solid rgba(235, 87, 87, 0.45); color: #ffb3b3; }
        .alert-info { background: rgba(29, 185, 84, 0.14); border: 1px solid rgba(29, 185, 84, 0.4); color: #b7f5ca; }
        .user-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          background: #161c22;
          border: 1px solid #232c35;
          border-radius: 10px;
          padding: 10px 12px;
        }
        .user-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .avatar {
          width: 34px;
          height: 34px;
          border-radius: 50%;
          object-fit: cover;
          background: #24303b;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          color: #1db954;
          flex-shrink: 0;
        }
        .user-name { font-size: 13px; font-weight: 700; color: #fff; }
        .user-actions { display: flex; gap: 4px; }
        .toggle-grid { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
        .toggle-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: #d6dfe7;
          cursor: pointer;
        }
        .progress-card {
          background: #161c22;
          border: 1px solid rgba(29, 185, 84, 0.35);
          border-radius: 10px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .progress-top {
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          font-weight: 600;
          color: #d7f7e0;
        }
        .progress-track {
          width: 100%;
          height: 6px;
          border-radius: 999px;
          background: #232d37;
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          background: #1db954;
          transition: width 0.2s ease;
        }
        .list-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 2px 2px 0;
        }
        .song-list { display: flex; flex-direction: column; gap: 8px; }
        .set-divider {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #7d8d9c;
          margin-top: 6px;
          padding-left: 2px;
        }
        .song-row {
          background: #161c22;
          border: 1px solid #232c35;
          border-radius: 9px;
          padding: 10px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .song-row.dimmed { opacity: 0.55; }
        .song-top {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 8px;
        }
        .song-check {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
          color: #ffffff;
        }
        .song-tags { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; flex-shrink: 0; }
        .tag, .badge {
          font-size: 10px;
          font-weight: 700;
          padding: 2px 7px;
          border-radius: 999px;
          white-space: nowrap;
        }
        .tag-tape { background: #2c2a3a; color: #c7bcf5; }
        .badge-good { background: rgba(29, 185, 84, 0.18); color: #5ce68a; }
        .badge-warn { background: rgba(242, 184, 75, 0.18); color: #f6c969; }
        .badge-miss { background: rgba(235, 87, 87, 0.18); color: #ff9c9c; }
        .match-line {
          display: flex;
          align-items: center;
          gap: 10px;
          background: #10151a;
          border-radius: 7px;
          padding: 7px 8px;
        }
        .miss-line { justify-content: space-between; }
        .art {
          width: 36px;
          height: 36px;
          border-radius: 5px;
          object-fit: cover;
          background: #232c35;
          flex-shrink: 0;
        }
        .match-info { flex: 1; min-width: 0; }
        .match-name {
          font-size: 12px;
          font-weight: 600;
          color: #eef3f7;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .match-artist {
          font-size: 11px;
          color: #93a2b0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .icon-btn {
          background: #222b35;
          border: none;
          color: #d3dde6;
          font-size: 11px;
          font-weight: 600;
          padding: 5px 9px;
          border-radius: 6px;
          cursor: pointer;
          flex-shrink: 0;
        }
        .icon-btn:hover { background: #2d3946; color: #fff; }
        .alt-select {
          width: 100%;
          background: #0d1115;
          border: 1px solid #27313c;
          color: #d2dce5;
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 11px;
        }
        .manual-box { display: flex; flex-direction: column; gap: 6px; padding-top: 2px; }
        .manual-results { display: flex; flex-direction: column; gap: 4px; }
        .manual-pick {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          text-align: left;
          background: #0e1318;
          border: 1px solid #242e38;
          border-radius: 6px;
          padding: 6px 8px;
          color: #e6edf3;
          cursor: pointer;
        }
        .manual-pick:hover { border-color: #1db954; background: #141c23; }
        .mini-art { width: 28px; height: 28px; border-radius: 4px; object-fit: cover; background: #232c35; flex-shrink: 0; }
        .manual-pick-text { display: flex; flex-direction: column; min-width: 0; font-size: 11px; }
        .manual-pick-text strong, .manual-pick-text span {
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .manual-pick-text span { color: #8f9ead; }
        .success-card { align-items: center; text-align: center; padding: 24px 18px; }
        .success-icon {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: rgba(29, 185, 84, 0.2);
          color: #1ed760;
          font-size: 24px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .success-title { font-size: 18px; font-weight: 700; color: #fff; }
        .success-name { font-size: 14px; font-weight: 600; color: #1ed760; }
        .success-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 8px; }
      </style>

      <div class="backdrop" id="s2s-backdrop">
        <div class="drawer" role="dialog" aria-modal="true" aria-label="Setlist.fm to Spotify">
          <div class="header">
            <div class="header-title">
              ${SPOTIFY_ICON_SVG}
              <span>Setlist.fm → Spotify</span>
            </div>
            <button type="button" class="close-btn" id="s2s-close-btn" aria-label="Close">×</button>
          </div>

          <div class="body">
            ${state.error ? `<div class="alert alert-error">${esc(state.error)}</div>` : ''}
            ${state.statusMessage ? `<div class="alert alert-info">${esc(state.statusMessage)}</div>` : ''}
            ${
              state.createdPlaylist
                ? renderSuccessSection()
                : !state.auth
                ? '<div class="card"><div class="muted">Loading Spotify connection...</div></div>'
                : state.showSetup || !state.auth.isAuthenticated
                ? renderSetupSection()
                : renderBuilderSection()
            }
          </div>

          ${
            showBuilder
              ? `<div class="footer">
                  <div class="muted small">
                    <strong>${selectedReadyCount}</strong> ${selectedReadyCount === 1 ? 'track' : 'tracks'} ready
                  </div>
                  <button
                    type="button"
                    class="btn btn-primary"
                    id="s2s-create-btn"
                    ${state.creating || state.matching || selectedReadyCount === 0 ? 'disabled' : ''}
                  >
                    ${state.creating ? 'Creating...' : 'Create Playlist on Spotify'}
                  </button>
                </div>`
              : ''
          }
        </div>
      </div>
    `;

    bindDrawerEvents();
  }

  function bindDrawerEvents() {
    const $ = (sel) => drawerShadow.querySelector(sel);
    const $$ = (sel) => Array.from(drawerShadow.querySelectorAll(sel));

    $('#s2s-close-btn')?.addEventListener('click', closeDrawer);
    $('#s2s-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 's2s-backdrop') closeDrawer();
    });

    // Setup actions
    $('#s2s-copy-redirect')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.auth?.redirectUri || '');
        state.statusMessage = 'Redirect URI copied to clipboard!';
        renderDrawer();
      } catch {
        $('#s2s-redirect-uri')?.select();
      }
    });

    $('#s2s-client-id')?.addEventListener('input', (e) => {
      const btn = $('#s2s-connect-btn');
      if (btn) btn.disabled = !e.target.value.trim();
    });

    $('#s2s-save-client-id')?.addEventListener('click', async () => {
      const value = $('#s2s-client-id')?.value || '';
      state.error = '';
      state.statusMessage = '';
      try {
        state.auth = await sendBg({ type: 'SAVE_CLIENT_ID', clientId: value });
        state.statusMessage = 'Client ID saved. Click "Sign in with Spotify" to connect.';
      } catch (err) {
        state.error = err.message;
      }
      renderDrawer();
    });

    $('#s2s-connect-btn')?.addEventListener('click', async () => {
      state.error = '';
      state.statusMessage = 'Waiting for Spotify authorization...';
      renderDrawer();
      try {
        // Save clientId first if user typed it without clicking Save
        const typedId = $('#s2s-client-id')?.value?.trim();
        if (typedId && typedId !== state.auth?.clientId) {
          state.auth = await sendBg({ type: 'SAVE_CLIENT_ID', clientId: typedId });
        }
        state.auth = await sendBg({ type: 'START_AUTH' });
        state.showSetup = false;
        state.statusMessage = '';
        renderDrawer();
        runMatchSongs();
      } catch (err) {
        state.statusMessage = '';
        state.error = err.message;
        renderDrawer();
      }
    });

    $('#s2s-back-builder')?.addEventListener('click', () => {
      state.showSetup = false;
      state.error = '';
      state.statusMessage = '';
      renderDrawer();
    });

    // Builder actions
    $('#s2s-open-setup')?.addEventListener('click', () => {
      state.showSetup = true;
      state.error = '';
      state.statusMessage = '';
      renderDrawer();
    });

    $('#s2s-logout')?.addEventListener('click', async () => {
      try {
        state.auth = await sendBg({ type: 'LOGOUT' });
        state.showSetup = true;
        state.statusMessage = 'Signed out of Spotify.';
      } catch (err) {
        state.error = err.message;
      }
      renderDrawer();
    });

    $('#s2s-playlist-name')?.addEventListener('input', (e) => {
      state.playlistName = e.target.value;
    });

    $('#s2s-playlist-desc')?.addEventListener('input', (e) => {
      state.playlistDescription = e.target.value;
    });

    $('#s2s-public-toggle')?.addEventListener('change', (e) => {
      state.isPublic = e.target.checked;
    });

    $('#s2s-tapes-toggle')?.addEventListener('change', (e) => {
      state.includeTapes = e.target.checked;
      for (const song of state.songs) {
        if (song.isTape) {
          song.selected = state.includeTapes;
        }
      }
      renderDrawer();
    });

    $('#s2s-rematch-btn')?.addEventListener('click', () => runMatchSongs());
    $('#s2s-create-btn')?.addEventListener('click', () => runCreatePlaylist());

    // Song checkboxes
    for (const cb of $$('.song-checkbox')) {
      cb.addEventListener('change', (e) => {
        const song = state.songs.find((s) => s.id === e.target.dataset.songId);
        if (song) {
          song.selected = e.target.checked;
          renderDrawer();
        }
      });
    }

    // Alternative match selects
    for (const sel of $$('.alt-select')) {
      sel.addEventListener('change', (e) => {
        const song = state.songs.find((s) => s.id === e.target.dataset.songId);
        if (!song) return;
        const chosen = song.alternatives.find((a) => a.uri === e.target.value);
        if (chosen) {
          song.selectedTrack = chosen;
          renderDrawer();
        }
      });
    }

    // Manual search toggle & execution
    for (const btn of $$('.toggle-manual-btn')) {
      btn.addEventListener('click', () => {
        const song = state.songs.find((s) => s.id === btn.dataset.songId);
        if (!song) return;
        song.manualOpen = !song.manualOpen;
        renderDrawer();
      });
    }

    for (const btn of $$('.manual-search-btn')) {
      btn.addEventListener('click', () => {
        const songId = btn.dataset.songId;
        const input = drawerShadow.querySelector(`.manual-input[data-song-id="${songId}"]`);
        runManualSearch(songId, input?.value || '');
      });
    }

    for (const input of $$('.manual-input')) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          runManualSearch(input.dataset.songId, input.value);
        }
      });
    }

    for (const pick of $$('.manual-pick')) {
      pick.addEventListener('click', () => {
        const song = state.songs.find((s) => s.id === pick.dataset.songId);
        const idx = Number(pick.dataset.pickIdx);
        const track = song?.manualResults?.[idx];
        if (!song || !track) return;
        song.selectedTrack = track;
        if (!song.alternatives.some((a) => a.uri === track.uri)) {
          song.alternatives = [track, ...song.alternatives];
        }
        song.selected = true;
        song.manualOpen = false;
        renderDrawer();
      });
    }

    // Success actions
    $('#s2s-copy-playlist-url')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.createdPlaylist?.url || '');
        state.statusMessage = 'Playlist URL copied!';
        renderDrawer();
      } catch {
        // Ignore clipboard denial
      }
    });

    $('#s2s-create-another')?.addEventListener('click', () => {
      state.createdPlaylist = null;
      state.statusMessage = '';
      renderDrawer();
    });
  }

  mountBanner();
})();
