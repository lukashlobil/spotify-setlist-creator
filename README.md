# Setlist.fm to Spotify

A browser extension for Chrome, Brave, Edge, Arc, Vivaldi, and Opera that turns any concert setlist on **setlist.fm** into a **Spotify playlist** in your library.

## Who Is This For?

- **Getting ready for an upcoming show:** Look up a band's recent setlist on setlist.fm, generate a Spotify playlist in seconds, and listen through the studio tracks before the concert.
- **Saving memories from a show you attended:** Open the setlist from a gig or festival you went to and save the exact tracklist to your Spotify library so you can revisit it anytime.

The extension matches **studio versions** of the songs on Spotify, lets you review or swap any track before saving, and lets you choose the playlist name, description, and whether it is public or private.

---

## How to Install & Use

### Step 1: Download the Extension
1. On this GitHub page, click the green **Code** button and choose **Download ZIP**.
2. Unzip the downloaded folder somewhere permanent on your computer (for example, `Documents/spotify-setlist-creator`).

### Step 2: Load It in Your Browser
1. Open your browser's extensions page:
   - **Chrome:** `chrome://extensions`
   - **Brave:** `brave://extensions`
   - **Edge:** `edge://extensions`
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the unzipped folder.

### Step 3: Connect Your Spotify Account (One-Time Setup)
Because the extension runs directly in your browser without any external server, you connect it to your own free Spotify app (takes about 1 minute):

1. Click the **Setlist.fm to Spotify** icon in your browser toolbar.
2. Click **Copy** next to the **Redirect URI** shown in the extension (it looks like `https://xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.chromiumapp.org/`).
3. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in with your Spotify account *(Spotify requires a Spotify Premium account to create an app)*.
4. Click **Create app**:
   - **App name:** anything you like (e.g., `My Setlist Creator`)
   - **App description:** anything you like (e.g., `Personal setlist playlist creator`)
   - **Redirect URIs:** paste the Redirect URI you copied from the extension and click **Add**
   - **Which API/SDKs are you planning to use?** check **Web API**
   - Accept the terms and click **Save**
5. Open your new app's **Settings** and copy the **Client ID**.
6. Go back to the extension, paste the **Client ID**, click **Save**, and click **Sign in with Spotify**.

Your Spotify credentials stay only in your browser — nothing is sent anywhere except directly to Spotify.

### Step 4: Create a Playlist from setlist.fm
1. Open any concert page on [setlist.fm](https://www.setlist.fm/) (for example, an upcoming tour's recent setlist or a show you attended).
2. Click the green **Create Spotify Playlist** button that appears above the setlist.
3. The extension automatically finds the studio version of each song on Spotify. You can:
   - Edit the playlist name and description
   - Choose **Private** or **Public**
   - Uncheck songs you don't want, pick an alternative match, or search manually
4. Click **Create Playlist on Spotify**, then click **Open in Spotify** to start listening.
