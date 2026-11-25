/**
 * Track title/artist normalization, Spotify search query generation, and studio-track match scoring.
 */

const EDITION_SUFFIX_RE =
  /\s*[-–—]\s*(?:remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|radio edit|single version|album version|explicit|clean|deluxe|bonus track).*$/i;

const PAREN_NOISE_RE =
  /\s*[\(\[](?:feat\.?|ft\.?|featuring|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|radio edit|single version|album version|explicit|clean|bonus track)[^\)\]]*[\)\]]/gi;

const LIVE_TRACK_RE =
  /\b(live|unplugged|in concert|concert|bootleg|bbc session|mtv unplugged|live at|live from|live in)\b/i;

const NON_ORIGINAL_RE =
  /\b(karaoke|tribute|cover|originally performed by|made famous by|8-bit|lullaby|piano version|acoustic cover)\b/i;

/**
 * Normalizes a string for fuzzy comparison: lowercases, strips accents/diacritics,
 * collapses punctuation and whitespace.
 */
export function normalizeText(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Strips common Spotify edition/remaster/featuring suffixes from a track title.
 */
export function stripEditionNoise(title) {
  return (title || '')
    .replace(PAREN_NOISE_RE, ' ')
    .replace(EDITION_SUFFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cleans a setlist.fm title into a query-friendly string for Spotify search.
 * Preserves key words while removing characters like `|` that can trip up field filters.
 */
export function sanitizeForSearch(text) {
  return (text || '')
    .replace(/[|\/]+/g, ' ')
    .replace(/[:"'?!()\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns true when a Spotify track is a live recording, cover, karaoke, or tribute version
 * so it can be excluded in favor of studio tracks only.
 */
export function isNonStudioTrack(spotifyTrack) {
  if (!spotifyTrack) return true;
  const trackName = spotifyTrack.name || '';
  const albumName = spotifyTrack.album?.name || '';
  const artistNames = (spotifyTrack.artists || []).map((a) => a.name || '').join(' ');

  if (LIVE_TRACK_RE.test(trackName) || LIVE_TRACK_RE.test(albumName)) {
    return true;
  }
  if (
    NON_ORIGINAL_RE.test(trackName) ||
    NON_ORIGINAL_RE.test(albumName) ||
    NON_ORIGINAL_RE.test(artistNames)
  ) {
    return true;
  }
  return false;
}

function tokenize(str) {
  const norm = normalizeText(str);
  return norm ? norm.split(' ') : [];
}

function tokenOverlap(aTokens, bTokens) {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const bSet = new Set(bTokens);
  let matches = 0;
  for (const t of aTokens) {
    if (bSet.has(t)) matches += 1;
  }
  return (2 * matches) / (aTokens.length + bTokens.length);
}

/**
 * Builds ordered Spotify search queries for a song (from most specific to broadest).
 *
 * @param {{ title: string }} song
 * @param {string} mainArtist
 * @returns {Array<{ query: string, expectedArtist: string }>}
 */
export function buildSearchQueries(song, mainArtist) {
  const cleanTitle = sanitizeForSearch(song.title);
  const strippedTitle = sanitizeForSearch(stripEditionNoise(song.title));
  const cleanArtist = sanitizeForSearch(mainArtist);
  const queries = [];
  const seen = new Set();

  const addQuery = (query, expectedArtist) => {
    const q = query.replace(/\s+/g, ' ').trim();
    if (!q || seen.has(q.toLowerCase())) return;
    seen.add(q.toLowerCase());
    queries.push({ query: q, expectedArtist });
  };

  if (cleanTitle && cleanArtist) {
    addQuery(`track:"${cleanTitle}" artist:"${cleanArtist}"`, mainArtist);
    addQuery(`${cleanTitle} ${cleanArtist}`, mainArtist);
    if (strippedTitle && strippedTitle.toLowerCase() !== cleanTitle.toLowerCase()) {
      addQuery(`${strippedTitle} ${cleanArtist}`, mainArtist);
    }
  }

  // Fallback without artist filter if artist names differ slightly on Spotify
  if (cleanTitle) {
    addQuery(`track:"${cleanTitle}"`, mainArtist || '');
  }

  return queries;
}

/**
 * Computes a studio match score (0 to 100) between a setlist song and a Spotify track object.
 * Non-studio (live, cover, tribute, karaoke) tracks score 0.
 *
 * @param {{ title: string }} song
 * @param {string} expectedArtist
 * @param {object} spotifyTrack
 * @returns {number}
 */
export function scoreTrackMatch(song, expectedArtist, spotifyTrack) {
  if (!spotifyTrack || !spotifyTrack.name) return 0;
  if (isNonStudioTrack(spotifyTrack)) return 0;

  const targetTitleRaw = normalizeText(song.title);
  const targetTitleClean = normalizeText(stripEditionNoise(song.title));
  const candTitleRaw = normalizeText(spotifyTrack.name);
  const candTitleClean = normalizeText(stripEditionNoise(spotifyTrack.name));

  // 1. Title similarity (up to 60 points)
  let titleScore = 0;
  if (candTitleRaw === targetTitleRaw || candTitleClean === targetTitleClean) {
    titleScore = 60;
  } else if (
    candTitleClean.includes(targetTitleClean) ||
    targetTitleClean.includes(candTitleClean)
  ) {
    const overlap = tokenOverlap(tokenize(targetTitleClean), tokenize(candTitleClean));
    titleScore = Math.round(42 + overlap * 14);
  } else {
    const overlap = tokenOverlap(tokenize(targetTitleClean), tokenize(candTitleClean));
    titleScore = Math.round(overlap * 50);
  }

  // 2. Artist similarity (up to 35 points)
  let artistScore = 0;
  const targetArtistNorm = normalizeText(expectedArtist);
  const trackArtists = (spotifyTrack.artists || []).map((a) => normalizeText(a.name));

  if (!targetArtistNorm) {
    artistScore = 15;
  } else {
    for (const candArtist of trackArtists) {
      if (!candArtist) continue;
      if (candArtist === targetArtistNorm) {
        artistScore = Math.max(artistScore, 35);
      } else if (
        candArtist.includes(targetArtistNorm) ||
        targetArtistNorm.includes(candArtist)
      ) {
        artistScore = Math.max(artistScore, 28);
      } else {
        const overlap = tokenOverlap(tokenize(targetArtistNorm), tokenize(candArtist));
        artistScore = Math.max(artistScore, Math.round(overlap * 26));
      }
    }
  }

  // 3. Popularity tie-breaker (up to 5 points)
  const popularity = typeof spotifyTrack.popularity === 'number' ? spotifyTrack.popularity : 0;
  const popularityScore = Math.round((Math.min(Math.max(popularity, 0), 100) / 100) * 5);

  return Math.max(0, Math.min(100, titleScore + artistScore + popularityScore));
}

/**
 * Ranks studio candidate Spotify tracks for a song and returns the best match + top alternatives.
 * Live recordings and covers/tributes are excluded.
 *
 * @param {{ title: string }} song
 * @param {string} expectedArtist
 * @param {Array<object>} candidates
 * @param {{ minConfidence?: number, maxAlternatives?: number }} [options]
 */
export function rankCandidates(song, expectedArtist, candidates, options = {}) {
  const minConfidence = options.minConfidence ?? 45;
  const maxAlternatives = options.maxAlternatives ?? 5;

  const deduped = new Map();
  for (const track of candidates || []) {
    if (!track || !track.uri) continue;
    if (isNonStudioTrack(track)) continue;

    const score = scoreTrackMatch(song, expectedArtist, track);
    const existing = deduped.get(track.uri);
    if (!existing || score > existing.score) {
      deduped.set(track.uri, {
        score,
        track: simplifyTrack(track),
      });
    }
  }

  const ranked = Array.from(deduped.values()).sort((a, b) => b.score - a.score);
  const best = ranked[0] && ranked[0].score >= minConfidence ? ranked[0] : null;

  return {
    bestMatch: best ? { ...best.track, confidence: best.score } : null,
    alternatives: ranked.slice(0, maxAlternatives).map((r) => ({
      ...r.track,
      confidence: r.score,
    })),
  };
}

export function simplifyTrack(track) {
  const images = track.album?.images || [];
  const smallImage = images[images.length - 1] || images[0] || null;
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: (track.artists || []).map((a) => a.name).join(', '),
    album: track.album?.name || '',
    imageUrl: smallImage?.url || '',
    externalUrl: track.external_urls?.spotify || '',
    durationMs: track.duration_ms || 0,
  };
}
