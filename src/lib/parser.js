/**
 * Setlist.fm DOM parser.
 * Extracts concert metadata (artist, venue, date, tour, url) and ordered song list
 * (including section headers, tape indicators, cover original artist, and notes).
 *
 * Works against a live browser `Document` as well as lightweight DOM stubs in tests.
 */

const UNKNOWN_SONG_PATTERNS = [
  /^unknown$/i,
  /^unknown song$/i,
  /^\(unknown\)$/i,
  /^\?+$/,
];

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function titleCaseSlug(slug) {
  return decodeURIComponent(slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

function parseJsonLd(doc) {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && (item['@type'] === 'MusicEvent' || item['@type'] === 'Event')) {
          return item;
        }
      }
    } catch {
      // Ignore invalid JSON-LD blocks
    }
  }
  return null;
}

function parseTitleFallback(title) {
  // Typical setlist.fm title: "The Ocean Setlist at Poble Espanyol, Barcelona"
  const match = cleanText(title).match(/^(.+?)\s+Setlist\s+at\s+(.+?)(?:\s*\|\s*setlist\.fm)?$/i);
  if (!match) return { artist: '', venue: '' };
  return {
    artist: cleanText(match[1]),
    venue: cleanText(match[2]),
  };
}

function parseUrlFallback(url) {
  try {
    const u = new URL(url);
    // /setlist/<artist>/<year>/<venue-city-country-id>.html
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'setlist' && parts.length >= 3) {
      return {
        artist: titleCaseSlug(parts[1]),
        year: /^\d{4}$/.test(parts[2]) ? parts[2] : '',
      };
    }
  } catch {
    // Ignore malformed URLs
  }
  return { artist: '', year: '' };
}

function extractArtist(doc, jsonLd, titleInfo, urlInfo) {
  const selectors = [
    '.setlistHeadline h1 strong a',
    '.setlistHeadline h1 a[href*="/setlists/"]',
    '.setlistHeadline h1 a',
    'h1 strong a',
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const text = cleanText(el?.textContent);
    if (text && !/^setlist$/i.test(text)) {
      return text;
    }
  }

  if (jsonLd?.performer) {
    const performer = Array.isArray(jsonLd.performer) ? jsonLd.performer[0] : jsonLd.performer;
    if (performer?.name) return cleanText(performer.name);
  }

  return titleInfo.artist || urlInfo.artist || '';
}

function extractVenue(doc, jsonLd, titleInfo) {
  const selectors = [
    '.setlistHeadline h1 a[href*="/venue/"]',
    '.setlistHeadline a[href*="/venue/"]',
    '.infoContainer a[href*="/venue/"]',
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const text = cleanText(el?.textContent);
    if (text) return text;
  }

  if (jsonLd?.location?.name) {
    const city = jsonLd.location?.address?.addressLocality;
    return city && !jsonLd.location.name.includes(city)
      ? `${cleanText(jsonLd.location.name)}, ${cleanText(city)}`
      : cleanText(jsonLd.location.name);
  }

  return titleInfo.venue || '';
}

function extractDate(doc, jsonLd, urlInfo) {
  const dateBlock = doc.querySelector('.dateBlock');
  if (dateBlock) {
    const month = cleanText(dateBlock.querySelector('.month')?.textContent);
    const day = cleanText(dateBlock.querySelector('.day')?.textContent);
    const year = cleanText(dateBlock.querySelector('.year')?.textContent);
    if (month && day && year) {
      return `${month} ${day}, ${year}`;
    }
    const combined = cleanText(dateBlock.textContent);
    if (combined) return combined;
  }

  if (jsonLd?.startDate) {
    return cleanText(String(jsonLd.startDate).slice(0, 10));
  }

  return urlInfo.year || '';
}

function extractTour(doc) {
  const tourLink = doc.querySelector(
    '.setlistHeadline a[href*="tour="], .infoContainer a[href*="tour="], .tour a'
  );
  return cleanText(tourLink?.textContent);
}

function extractNote(songEl) {
  const infoPart = songEl.querySelector('.infoPart');
  if (!infoPart) return '';
  const text = cleanText(infoPart.textContent);
  return text.replace(/^\((.*)\)$/, '$1').trim();
}

function isTapeItem(songEl) {
  const className = songEl.className || '';
  if (/\btape\b/i.test(className)) return true;

  const infoPart = songEl.querySelector('.infoPart');
  const infoText = cleanText(infoPart?.textContent);
  if (/\b(played from tape|song played from tape|on tape)\b/i.test(infoText)) return true;

  const iconTitle = songEl.querySelector('[title*="tape" i], [aria-label*="tape" i]');
  if (iconTitle) return true;

  return false;
}

function isSectionHeader(li) {
  const className = li.className || '';
  if (/\b(section|encore)\b/i.test(className) && !li.querySelector('.songLabel')) {
    return true;
  }
  if (/\bhighlight\b/i.test(className) && !li.querySelector('.songLabel')) {
    return true;
  }
  return false;
}

function extractSongTitle(songEl) {
  const labelSelectors = [
    '.songPart a.songLabel',
    '.songPart .songLabel',
    'a.songLabel',
    '.songLabel',
  ];
  for (const sel of labelSelectors) {
    const el = songEl.querySelector(sel);
    const text = cleanText(el?.textContent);
    if (text) return text;
  }
  return '';
}

/**
 * Parses a setlist.fm setlist page document into structured concert and track data.
 *
 * @param {Document} doc
 * @param {string} [pageUrl]
 * @returns {{
 *   artist: string,
 *   venue: string,
 *   date: string,
 *   tour: string,
 *   url: string,
 *   suggestedPlaylistName: string,
 *   suggestedDescription: string,
 *   songs: Array<{
 *     id: string,
 *     title: string,
 *     section: string,
 *     isTape: boolean,
 *     note: string,
 *     selected: boolean
 *   }>
 * }}
 */
export function parseSetlistDocument(doc, pageUrl = '') {
  const url = pageUrl || doc.location?.href || '';
  const jsonLd = parseJsonLd(doc);
  const titleInfo = parseTitleFallback(doc.title || '');
  const urlInfo = parseUrlFallback(url);

  const artist = extractArtist(doc, jsonLd, titleInfo, urlInfo);
  const venue = extractVenue(doc, jsonLd, titleInfo);
  const date = extractDate(doc, jsonLd, urlInfo);
  const tour = extractTour(doc);

  const container =
    doc.querySelector('.setlistList') ||
    doc.querySelector('.setlistContent') ||
    doc;

  const listItems = Array.from(container.querySelectorAll('li'));
  const songs = [];
  let currentSection = 'Main Set';

  for (const li of listItems) {
    if (isSectionHeader(li)) {
      const heading = cleanText(li.textContent).replace(/:$/, '');
      if (heading) currentSection = heading;
      continue;
    }

    const title = extractSongTitle(li);
    if (!title) continue;
    if (UNKNOWN_SONG_PATTERNS.some((re) => re.test(title))) continue;

    const isTape = isTapeItem(li);
    const note = extractNote(li);

    songs.push({
      id: `song-${songs.length + 1}`,
      title,
      section: currentSection,
      isTape,
      note,
      selected: !isTape,
    });
  }

  // Fallback: if DOM used non-<li> containers for .songLabel
  if (songs.length === 0) {
    const labels = Array.from(container.querySelectorAll('.songLabel'));
    for (const label of labels) {
      const title = cleanText(label.textContent);
      if (!title || UNKNOWN_SONG_PATTERNS.some((re) => re.test(title))) continue;
      songs.push({
        id: `song-${songs.length + 1}`,
        title,
        section: 'Main Set',
        isTape: false,
        note: '',
        selected: true,
      });
    }
  }

  const nameParts = [];
  if (artist) nameParts.push(artist);
  if (venue) nameParts.push(venue);
  const baseName = nameParts.join(' — ') || 'Setlist.fm Playlist';
  const suggestedPlaylistName = date ? `${baseName} (${date})` : baseName;

  const descParts = ['Setlist'];
  if (artist) descParts.push(`by ${artist}`);
  if (venue) descParts.push(`at ${venue}`);
  if (date) descParts.push(`on ${date}`);
  if (tour) descParts.push(`(${tour})`);
  const suggestedDescription = url
    ? `${descParts.join(' ')} — ${url}`
    : descParts.join(' ');

  return {
    artist,
    venue,
    date,
    tour,
    url,
    suggestedPlaylistName,
    suggestedDescription,
    songs,
  };
}
