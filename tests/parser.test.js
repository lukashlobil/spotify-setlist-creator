import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSetlistDocument } from '../src/lib/parser.js';

function makeElement({
  tag = 'div',
  className = '',
  textContent = '',
  attrs = {},
  children = [],
} = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    className,
    attrs,
    children,
    get textContent() {
      if (textContent) return textContent;
      return children.map((c) => c.textContent).join(' ');
    },
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    matches(selector) {
      return matchesSimpleChain(el, selector);
    },
    querySelectorAll(selectorList) {
      const selectors = selectorList.split(',').map((s) => s.trim()).filter(Boolean);
      const out = [];
      const visit = (node, ancestors) => {
        for (const child of node.children || []) {
          const nextAncestors = [...ancestors, node];
          if (selectors.some((sel) => matchesSelector(child, nextAncestors, sel))) {
            out.push(child);
          }
          visit(child, nextAncestors);
        }
      };
      visit(el, []);
      return out;
    },
    querySelector(selectorList) {
      return el.querySelectorAll(selectorList)[0] || null;
    },
  };
  return el;
}

function matchesSimpleChain(el, part) {
  let rest = part.trim();
  const tagMatch = rest.match(/^[a-z0-9]+/i);
  if (tagMatch) {
    if (el.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  const attrRegex = /\[([a-z0-9_-]+)(\*?=)"([^"]+)"(?:\s+i)?\]/gi;
  let m;
  while ((m = attrRegex.exec(rest)) !== null) {
    const [, name, op, val] = m;
    const actual = el.getAttribute(name);
    if (actual === null) return false;
    const a = actual.toLowerCase();
    const v = val.toLowerCase();
    if (op === '=' && a !== v) return false;
    if (op === '*=' && !a.includes(v)) return false;
  }
  rest = rest.replace(attrRegex, '');

  const classes = rest.split('.').filter(Boolean);
  const elClasses = (el.className || '').split(/\s+/).filter(Boolean);
  for (const cls of classes) {
    if (!elClasses.includes(cls)) return false;
  }
  return true;
}

function matchesSelector(el, ancestors, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesSimpleChain(el, parts[parts.length - 1])) return false;
  if (parts.length === 1) return true;

  let ancIdx = ancestors.length - 1;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    let matched = false;
    while (ancIdx >= 0) {
      if (matchesSimpleChain(ancestors[ancIdx], parts[i])) {
        matched = true;
        ancIdx -= 1;
        break;
      }
      ancIdx -= 1;
    }
    if (!matched) return false;
  }
  return true;
}

function makeSetlistDoc({ artist, venue, month, day, year, songs, url }) {
  const liNodes = songs.map((s) => {
    if (s.sectionHeader) {
      return makeElement({
        tag: 'li',
        className: 'setlistParts encore',
        textContent: s.sectionHeader,
      });
    }
    const children = [
      makeElement({
        tag: 'div',
        className: 'songPart',
        children: [
          makeElement({
            tag: 'a',
            className: 'songLabel',
            textContent: s.title,
            attrs: { href: '/song/example' },
          }),
        ],
      }),
    ];
    if (s.info) {
      children.push(
        makeElement({
          tag: 'div',
          className: 'infoPart',
          textContent: s.info,
        })
      );
    }
    return makeElement({
      tag: 'li',
      className: s.isTape ? 'setlistParts tape' : 'setlistParts song',
      children,
    });
  });

  const root = makeElement({
    tag: 'html',
    children: [
      makeElement({
        tag: 'div',
        className: 'dateBlock',
        children: [
          makeElement({ tag: 'span', className: 'month', textContent: month }),
          makeElement({ tag: 'span', className: 'day', textContent: day }),
          makeElement({ tag: 'span', className: 'year', textContent: year }),
        ],
      }),
      makeElement({
        tag: 'div',
        className: 'setlistHeadline',
        children: [
          makeElement({
            tag: 'h1',
            children: [
              makeElement({
                tag: 'strong',
                children: [
                  makeElement({
                    tag: 'a',
                    textContent: artist,
                    attrs: { href: '/setlists/the-ocean.html' },
                  }),
                ],
              }),
              makeElement({
                tag: 'a',
                textContent: venue,
                attrs: { href: '/venue/poble-espanyol-barcelona-spain.html' },
              }),
            ],
          }),
        ],
      }),
      makeElement({
        tag: 'div',
        className: 'setlistList',
        children: [makeElement({ tag: 'ol', children: liNodes })],
      }),
    ],
  });

  root.title = `${artist} Setlist at ${venue} | setlist.fm`;
  root.location = { href: url };
  return root;
}

test('parses The Ocean at Poble Espanyol setlist with sections, tape, and skips Unknown', () => {
  const url = 'https://www.setlist.fm/setlist/the-ocean/2026/poble-espanyol-barcelona-spain-34a493f.html';
  const doc = makeSetlistDoc({
    artist: 'The Ocean',
    venue: 'Poble Espanyol, Barcelona, Spain',
    month: 'Sep',
    day: '25',
    year: '2026',
    url,
    songs: [
      { title: 'Intro Tape', isTape: true, info: '(Song played from tape)' },
      { title: 'Light Pollution' },
      { title: 'Pleistocene' },
      { title: 'Preboreal' },
      { title: 'Mesopelagic: Into the Uncanny' },
      { title: 'Miocene | Pliocene' },
      { title: 'Jurassic | Cretaceous' },
      { title: 'Unknown' },
      { sectionHeader: 'Encore:' },
      { title: 'Ultima Esperanza' },
    ],
  });

  const parsed = parseSetlistDocument(doc, url);

  assert.equal(parsed.artist, 'The Ocean');
  assert.equal(parsed.venue, 'Poble Espanyol, Barcelona, Spain');
  assert.equal(parsed.date, 'Sep 25, 2026');
  assert.equal(
    parsed.suggestedPlaylistName,
    'The Ocean — Poble Espanyol, Barcelona, Spain (Sep 25, 2026)'
  );
  assert.ok(parsed.suggestedDescription.includes(url));

  assert.equal(parsed.songs.length, 8);
  assert.equal(parsed.songs[0].title, 'Intro Tape');
  assert.equal(parsed.songs[0].isTape, true);
  assert.equal(parsed.songs[0].selected, false);

  assert.equal(parsed.songs[1].title, 'Light Pollution');
  assert.equal(parsed.songs[1].section, 'Main Set');
  assert.equal(parsed.songs[1].selected, true);

  assert.equal(parsed.songs[5].title, 'Miocene | Pliocene');

  assert.equal(parsed.songs[7].title, 'Ultima Esperanza');
  assert.equal(parsed.songs[7].section, 'Encore');
});

test('falls back to document.title and URL when headline selectors are absent', () => {
  const doc = makeElement({
    tag: 'html',
    children: [
      makeElement({
        tag: 'div',
        className: 'setlistList',
        children: [
          makeElement({ tag: 'span', className: 'songLabel', textContent: 'Preboreal' }),
        ],
      }),
    ],
  });
  doc.title = 'The Ocean Setlist at Poble Espanyol, Barcelona | setlist.fm';
  const url = 'https://www.setlist.fm/setlist/the-ocean/2026/poble-espanyol-barcelona-spain-34a493f.html';

  const parsed = parseSetlistDocument(doc, url);
  assert.equal(parsed.artist, 'The Ocean');
  assert.equal(parsed.venue, 'Poble Espanyol, Barcelona');
  assert.equal(parsed.date, '2026');
  assert.equal(parsed.songs.length, 1);
  assert.equal(parsed.songs[0].title, 'Preboreal');
});
