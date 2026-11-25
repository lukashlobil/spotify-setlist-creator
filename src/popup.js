/**
 * Extension toolbar popup UI:
 * - Detects if the active tab is a setlist.fm setlist page and opens the on-page importer
 * - Manages Spotify OAuth 2.0 PKCE setup (Redirect URI, Client ID, Sign in / Sign out)
 * - Displays recently created Spotify playlists
 */

const root = document.getElementById('root');

const state = {
  auth: null,
  activeTab: null,
  setlist: null,
  showSettings: false,
  error: '',
  info: '',
  busy: false,
};

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendBg(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'Request failed.'));
        return;
      }
      resolve(response.data);
    });
  });
}

function sendTab(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function isSetlistPage(url) {
  return /^https:\/\/(?:www\.)?setlist\.fm\/setlist\//i.test(url || '');
}

async function init() {
  try {
    const [auth, tabs] = await Promise.all([
      sendBg({ type: 'GET_AUTH_STATE' }),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);

    state.auth = auth;
    state.showSettings = !auth.clientId || !auth.isAuthenticated;
    state.activeTab = tabs[0] || null;

    if (state.activeTab && isSetlistPage(state.activeTab.url)) {
      try {
        const res = await sendTab(state.activeTab.id, { type: 'GET_PAGE_SETLIST' });
        if (res?.ok && res.data) {
          state.setlist = res.data;
        }
      } catch {
        // Content script may not have injected yet if tab was opened before extension install
      }
    }
  } catch (err) {
    state.error = err.message;
  }

  render();
}

function renderActivePageCard() {
  if (state.activeTab && isSetlistPage(state.activeTab.url)) {
    const songCount = state.setlist?.songs?.filter((s) => !s.isTape).length ?? 0;
    const title = state.setlist?.artist
      ? `${state.setlist.artist}${state.setlist.venue ? ` — ${state.setlist.venue}` : ''}`
      : 'Setlist.fm Page Detected';
    const sub = state.setlist
      ? `${songCount} ${songCount === 1 ? 'song' : 'songs'}${state.setlist.date ? ` • ${state.setlist.date}` : ''}`
      : 'Refresh the page if the importer does not open.';

    return `
      <section class="card card-highlight">
        <div class="section-title">Current Setlist</div>
        <div class="title">${esc(title)}</div>
        <p class="muted">${esc(sub)}</p>
        <button type="button" class="btn btn-primary btn-full" id="open-drawer-btn">
          Open Playlist Builder on Page
        </button>
      </section>
    `;
  }

  return `
    <section class="card">
      <div class="section-title">How to Use</div>
      <p class="muted">
        Open any concert page on <strong>setlist.fm</strong> to automatically detect the setlist and turn it into a Spotify playlist.
      </p>
      <a class="btn btn-secondary btn-full" href="https://www.setlist.fm/" target="_blank" rel="noopener noreferrer">
        Browse setlist.fm
      </a>
    </section>
  `;
}

function renderAuthCard() {
  const auth = state.auth;
  if (!auth) return '';

  if (auth.isAuthenticated && !state.showSettings) {
    return `
      <section class="card">
        <div class="user-row">
          <div class="user-left">
            ${
              auth.user?.avatarUrl
                ? `<img src="${esc(auth.user.avatarUrl)}" alt="" class="avatar" />`
                : '<div class="avatar">♪</div>'
            }
            <div>
              <div class="title" style="font-size: 13px;">${esc(auth.user?.displayName || 'Spotify Connected')}</div>
              <div class="muted">Ready to create playlists</div>
            </div>
          </div>
          <div class="row">
            <button type="button" class="btn btn-ghost btn-sm" id="toggle-settings-btn">Settings</button>
            <button type="button" class="btn btn-ghost btn-sm" id="logout-btn">Sign out</button>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="card">
      <div class="user-row">
        <div class="section-title">Spotify Connection</div>
        ${
          auth.isAuthenticated
            ? '<button type="button" class="btn btn-ghost btn-sm" id="hide-settings-btn">Done</button>'
            : ''
        }
      </div>

      <ol class="steps">
        <li>Create a free app in <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer">Spotify Developer Dashboard</a> (enable <strong>Web API</strong>).</li>
        <li>Add this exact Redirect URI to your app settings:</li>
      </ol>

      <div class="row">
        <input type="text" readonly class="input mono" id="redirect-uri" value="${esc(auth.redirectUri)}" />
        <button type="button" class="btn btn-secondary btn-sm" id="copy-redirect-btn">Copy</button>
      </div>

      <label class="field-label" for="client-id-input">Spotify Client ID</label>
      <div class="row">
        <input
          type="text"
          class="input mono"
          id="client-id-input"
          placeholder="32-char Client ID"
          value="${esc(auth.clientId)}"
        />
        <button type="button" class="btn btn-secondary btn-sm" id="save-client-id-btn">Save</button>
      </div>

      <button
        type="button"
        class="btn btn-primary btn-full"
        id="connect-spotify-btn"
        ${state.busy || !auth.clientId ? 'disabled' : ''}
      >
        ${state.busy ? 'Connecting...' : auth.isAuthenticated ? 'Reconnect Spotify' : 'Sign in with Spotify'}
      </button>
    </section>
  `;
}

function renderRecentPlaylists() {
  const recents = state.auth?.recentPlaylists || [];
  if (recents.length === 0) return '';

  return `
    <section class="card">
      <div class="section-title">Recent Playlists</div>
      <div class="recent-list">
        ${recents
          .slice(0, 5)
          .map(
            (p) => `
              <a class="recent-item" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">
                <div class="recent-meta">
                  <div class="recent-name">${esc(p.name)}</div>
                  <div class="recent-sub">${p.trackCount} tracks • ${p.isPublic ? 'Public' : 'Private'}</div>
                </div>
                <span class="open-arrow">↗</span>
              </a>
            `
          )
          .join('')}
      </div>
    </section>
  `;
}

function render() {
  root.innerHTML = `
    ${state.error ? `<div class="alert alert-error">${esc(state.error)}</div>` : ''}
    ${state.info ? `<div class="alert alert-info">${esc(state.info)}</div>` : ''}
    ${renderActivePageCard()}
    ${renderAuthCard()}
    ${renderRecentPlaylists()}
  `;

  bindEvents();
}

function bindEvents() {
  document.getElementById('open-drawer-btn')?.addEventListener('click', async () => {
    if (!state.activeTab?.id) return;
    try {
      await sendTab(state.activeTab.id, { type: 'OPEN_DRAWER' });
      window.close();
    } catch {
      state.error = 'Please refresh the setlist.fm tab once so the extension can attach.';
      render();
    }
  });

  document.getElementById('toggle-settings-btn')?.addEventListener('click', () => {
    state.showSettings = true;
    state.error = '';
    state.info = '';
    render();
  });

  document.getElementById('hide-settings-btn')?.addEventListener('click', () => {
    state.showSettings = false;
    state.error = '';
    state.info = '';
    render();
  });

  document.getElementById('copy-redirect-btn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.auth?.redirectUri || '');
      state.info = 'Redirect URI copied!';
      state.error = '';
    } catch {
      document.getElementById('redirect-uri')?.select();
    }
    render();
  });

  document.getElementById('client-id-input')?.addEventListener('input', (e) => {
    const connectBtn = document.getElementById('connect-spotify-btn');
    if (connectBtn) {
      connectBtn.disabled = state.busy || !e.target.value.trim();
    }
  });

  document.getElementById('save-client-id-btn')?.addEventListener('click', async () => {
    const value = document.getElementById('client-id-input')?.value || '';
    state.error = '';
    state.info = '';
    try {
      state.auth = await sendBg({ type: 'SAVE_CLIENT_ID', clientId: value });
      state.info = 'Client ID saved.';
    } catch (err) {
      state.error = err.message;
    }
    render();
  });

  document.getElementById('connect-spotify-btn')?.addEventListener('click', async () => {
    state.busy = true;
    state.error = '';
    state.info = '';
    render();

    try {
      const typedId = document.getElementById('client-id-input')?.value?.trim();
      if (typedId && typedId !== state.auth?.clientId) {
        state.auth = await sendBg({ type: 'SAVE_CLIENT_ID', clientId: typedId });
      }
      state.auth = await sendBg({ type: 'START_AUTH' });
      state.showSettings = false;
      state.info = `Signed in as ${state.auth.user?.displayName || 'Spotify user'}!`;
    } catch (err) {
      state.error = err.message;
    } finally {
      state.busy = false;
      render();
    }
  });

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    state.error = '';
    state.info = '';
    try {
      state.auth = await sendBg({ type: 'LOGOUT' });
      state.showSettings = true;
      state.info = 'Signed out of Spotify.';
    } catch (err) {
      state.error = err.message;
    }
    render();
  });
}

init();
