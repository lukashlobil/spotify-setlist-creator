import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchQueries,
  isNonStudioTrack,
  normalizeText,
  rankCandidates,
  sanitizeForSearch,
  scoreTrackMatch,
} from '../src/lib/matcher.js';

test('normalizeText strips diacritics and punctuation cleanly', () => {
  assert.equal(normalizeText('Miocene | Pliocene'), 'miocene pliocene');
  assert.equal(normalizeText('Mesopelagic: Into the Uncanny'), 'mesopelagic into the uncanny');
  assert.equal(normalizeText('Café & Déjà Vu'), 'cafe and deja vu');
});

test('sanitizeForSearch handles pipes and colons for Spotify query syntax', () => {
  assert.equal(sanitizeForSearch('Jurassic | Cretaceous'), 'Jurassic Cretaceous');
  assert.equal(sanitizeForSearch('Mesopelagic: Into the Uncanny'), 'Mesopelagic Into the Uncanny');
});

test('buildSearchQueries always searches by the setlist performing artist', () => {
  const queries = buildSearchQueries({ title: 'Pleistocene' }, 'The Ocean');
  assert.equal(queries[0].expectedArtist, 'The Ocean');
  assert.ok(queries[0].query.includes('artist:"The Ocean"'));
});

test('rankCandidates keeps studio tracks only and excludes live and cover/tribute versions', () => {
  const song = { title: 'Jurassic | Cretaceous' };

  const studio = {
    id: '1',
    uri: 'spotify:track:1',
    name: 'Jurassic | Cretaceous',
    artists: [{ name: 'The Ocean' }],
    album: { name: 'Phanerozoic II: Mesozoic | Cenozoic', images: [] },
    popularity: 52,
  };

  const live = {
    id: '2',
    uri: 'spotify:track:2',
    name: 'Jurassic | Cretaceous - Live',
    artists: [{ name: 'The Ocean' }],
    album: { name: 'Phanerozoic Live', images: [] },
    popularity: 40,
  };

  const cover = {
    id: '3',
    uri: 'spotify:track:3',
    name: 'Jurassic | Cretaceous (Acoustic Cover)',
    artists: [{ name: 'Tribute Band' }],
    album: { name: 'Metal Covers', images: [] },
    popularity: 20,
  };

  assert.equal(isNonStudioTrack(studio), false);
  assert.equal(isNonStudioTrack(live), true);
  assert.equal(isNonStudioTrack(cover), true);

  assert.ok(scoreTrackMatch(song, 'The Ocean', studio) >= 95);
  assert.equal(scoreTrackMatch(song, 'The Ocean', live), 0);
  assert.equal(scoreTrackMatch(song, 'The Ocean', cover), 0);

  const ranked = rankCandidates(song, 'The Ocean', [cover, live, studio]);
  assert.equal(ranked.bestMatch.uri, 'spotify:track:1');
  assert.equal(ranked.alternatives.length, 1);

  const onlyLive = rankCandidates(song, 'The Ocean', [live, cover]);
  assert.equal(onlyLive.bestMatch, null);
  assert.equal(onlyLive.alternatives.length, 0);
});
