# Chrome Web Store Publishing Guide & Listing Copy

Use this checklist and copy-pasteable form text when submitting to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (or Microsoft Edge Add-ons).

---

## Important Note About Spotify API Limits (2026)

Spotify limits **Development Mode** apps to **5 allowlisted users** and restricts **Extended Quota Mode** to registered organizations with established scale. Because this extension uses **Bring-Your-Own Spotify Client ID (OAuth 2.0 PKCE)** directly in the browser:
- Anyone who installs your extension can connect their own free Spotify Developer App in ~30 seconds.
- You never hit a 5-user limit, never pay for a backend server, and never handle user secrets.
- Be transparent about this 1-time setup in the store description (included below) so users and reviewers know what to expect.

---

## Before You Submit

1. **Developer Account**: Register at the Chrome Web Store Developer Dashboard (one-time \$5 USD fee).
2. **Host Privacy Policy**: Publish `docs/privacy.html` to a public HTTPS URL (for example, push this repo to GitHub and enable **GitHub Pages** from `/docs`, giving `https://<username>.github.io/<repo>/privacy.html`).
3. **Capture 2–3 Screenshots (`1280x800` PNG)**:
   - Screenshot 1: A `setlist.fm` concert page showing the green **Create Spotify Playlist** banner above the setlist.
   - Screenshot 2: The slide-over drawer open with matched tracks, album art, confidence badges, and the **Create Playlist on Spotify** button.
   - Screenshot 3: The playlist created confirmation screen or the toolbar popup.
4. **Trademark-Safe Store Name (Recommended)**:
   - Chrome Web Store reviewers sometimes flag names that imply official affiliation with third-party brands. Using a phrase like **`Setlist Exporter for setlist.fm & Spotify`** (with `"unofficial"` noted in the description) avoids trademark rejections. If you change the name, update `"name"` in `manifest.json` and re-run `npm run package`.
5. **Build the Release ZIP**:
   ```bash
   npm run package
   ```
   Upload `dist/setlist-to-spotify-v1.0.0.zip`.

---

## Store Listing Form Fields

### Short Description (manifest `description`, max 132 chars)
> Turn any setlist.fm concert setlist into a Spotify playlist in your library with one click.

### Detailed Description
```text
Turn any concert setlist on setlist.fm into a Spotify playlist directly inside your browser — no external servers, no account sharing.

FEATURES
• Automatic Detection on setlist.fm: Injects a clean "Create Spotify Playlist" button right above any concert setlist page.
• Smart Track Matching: Handles encores, multi-part titles (like "Miocene | Pliocene"), edition/remaster noise, and tape/intro tracks (deselected by default), matching studio tracks only.
• Full Control Before Creating: Edit the playlist name, description, and Public/Private visibility; uncheck songs; pick from top alternative matches; or manually search Spotify for any track.
• Direct to Your Library: Uses Spotify OAuth 2.0 PKCE directly from your browser with automatic token refresh.

ONE-TIME SETUP (30 SECONDS)
Because Spotify limits shared developer apps, this extension connects directly using your own free Spotify Developer App (no backend server collects your data):
1. Open the extension and copy the displayed Redirect URI.
2. Create a free app at developer.spotify.com/dashboard, add the Redirect URI, and enable Web API.
3. Paste your Client ID into the extension and sign in with Spotify.

Note: This is an independent, unofficial extension and is not affiliated with or endorsed by setlist.fm or Spotify.
```

### Category
- **Tools** (or **Entertainment** / **Productivity**)

---

## Privacy Tab Form Fields

### Single Purpose Description
> Parses concert setlists displayed on setlist.fm pages and creates matching playlists in the user's Spotify library via the official Spotify Web API.

### Permission Justifications

- **`activeTab`**:
  > Used when the user clicks the extension toolbar icon to check whether the currently active tab is a `setlist.fm/setlist/*` page and to open the in-page playlist builder drawer on that tab.

- **`identity`**:
  > Used exclusively for `chrome.identity.launchWebAuthFlow` and `chrome.identity.getRedirectURL()` to authenticate the user with Spotify via OAuth 2.0 PKCE (`https://accounts.spotify.com/authorize`).

- **`storage`**:
  > Used strictly with `chrome.storage.local` to store the user's Spotify Client ID, OAuth 2.0 access/refresh tokens, basic connected profile info (name/avatar), and a local history of recently created playlists.

- **Host permissions (`https://accounts.spotify.com/*`, `https://api.spotify.com/*`)**:
  > Required by the background service worker to exchange/refresh Spotify OAuth 2.0 PKCE tokens (`accounts.spotify.com`) and to search for tracks, read the signed-in user's profile, and create playlists (`api.spotify.com`).

- **Content script (`https://www.setlist.fm/setlist/*`, `https://setlist.fm/setlist/*`)**:
  > Reads the visible concert metadata and song titles from the current `setlist.fm` page DOM and displays an isolated Shadow DOM banner and slide-over playlist builder drawer.

- **Remote code**:
  > **No** — all code is bundled inside the extension package.

### Data Usage Disclosures
- Check: **Authentication information** (Spotify OAuth tokens stored locally only) and **Website content** (song titles/concert metadata read locally from `setlist.fm` to query Spotify).
- Certify all 3 Limited Use declarations (data is not sold, not used outside single purpose, not used for creditworthiness/lending).
- **Privacy Policy URL**: Your hosted HTTPS URL for `docs/privacy.html`.

---

## Reviewer Test Instructions (Paste into "Test instructions" on CWS)

```text
1. Open any concert page on setlist.fm, for example:
   https://www.setlist.fm/setlist/the-ocean/2026/poble-espanyol-barcelona-spain-34a493f.html
2. Observe the injected "Create a Spotify Playlist from this Setlist" banner above the tracklist and click "Create Spotify Playlist" (or click the extension toolbar icon).
3. In the setup panel, copy the shown Redirect URI (https://<extension-id>.chromiumapp.org/), add it to a Spotify Developer App at https://developer.spotify.com/dashboard (Web API enabled), paste the app's 32-character Client ID, click Save, and click "Sign in with Spotify".
4. After authorizing, the extension automatically searches Spotify for each song, displays matches with confidence scores and swap/manual-search controls, and creates the playlist in the signed-in Spotify library when "Create Playlist on Spotify" is clicked.
```
