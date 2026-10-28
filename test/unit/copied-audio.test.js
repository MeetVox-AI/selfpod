import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findCopiedAudio, signatureOf } from '../../src/lib/copied-audio.js';
import { frameProfile } from '../../src/lib/mp3-frames.js';
import { FRAME_MS, frame, segment, stitch } from '../helpers/mp3.js';

/**
 * Synthesised episodes, frame by frame. A seed range is "the same audio, encoded the same
 * way": two episodes built with the same seeds share those frames byte for byte, exactly
 * as an advert a host concatenates in does — and episodes built with different seeds
 * share nothing, as two separately mastered programmes do.
 *
 * Nothing here can stand in for a real host. The shapes are taken from what two real
 * ones served on 2026-10-28 (scripts/check-copied-audio.mjs): RMC's opener at 0:00 in
 * two versions differing in their last frame; Acast's 2.2 s marker at the edge of every
 * break, twice back to back at the start of a post-roll.
 */
const frames = (seconds) => Math.round((seconds * 1000) / FRAME_MS);

function episode(id, ...parts) {
  const profile = frameProfile(stitch(...parts));
  return { id, hashes: profile.hashes, frameMs: profile.durationMs / profile.frameCount };
}

/*
 * Seeds are frame numbers, and a part of N frames uses N consecutive ones — so parts
 * are spaced further apart than any part is long, or two "different" adverts would share
 * frames and the tests would be about that instead. Adverts (at most 100 s, 3,830
 * frames) sit 10,000 apart below a million; programme halves (at most 900 s, 34,456
 * frames) 50,000 apart above it, and episodes 100,000 apart.
 */
const programme = (n, seconds, part = 0) => segment(1_000_000 + n * 100_000 + part * 50_000, frames(seconds));
const advert = (seed, seconds) => segment(seed * 10, frames(seconds));
const MARKER = () => advert(7_000, 2.2);

describe('finding audio a host copied into several episodes', () => {
  it('finds a stretch that is the same frames in two episodes, exactly where it is', () => {
    const result = findCopiedAudio([
      episode('a', programme(1, 60), advert(500, 30), programme(1, 60, 1)),
      episode('b', programme(2, 45), advert(500, 30), programme(2, 90, 1)),
    ]);
    assert.equal(result.copied.length, 1);
    const [row] = result.copied;
    assert.equal(row.episodeCount, 2);
    const byEpisode = Object.fromEntries(row.occurrences.map((o) => [o.episodeId, [o.startFrame, o.endFrame]]));
    assert.deepEqual(byEpisode, { a: [frames(60), frames(60) + frames(30)], b: [frames(45), frames(45) + frames(30)] });
  });

  it('finds nothing between episodes that share no frames — separately mastered programmes', () => {
    const result = findCopiedAudio([
      episode('a', programme(1, 120)),
      episode('b', programme(2, 120)),
      episode('c', programme(3, 120)),
    ]);
    assert.deepEqual(result, { copied: [], markers: [], blocks: [] });
  });

  it('does not call shared silence a copy', () => {
    // Silence encodes to the same frame over and over; two episodes with a second of it
    // each would otherwise "share" it.
    const silence = Buffer.concat(Array.from({ length: frames(3) }, () => frame(42)));
    const result = findCopiedAudio([
      episode('a', programme(1, 30), silence, programme(1, 30, 1)),
      episode('b', programme(2, 30), silence, programme(2, 30, 1)),
    ]);
    assert.deepEqual(result.copied, []);
  });

  it('ignores a shared stretch shorter than a second and a half', () => {
    const result = findCopiedAudio([
      episode('a', programme(1, 30), advert(500, 1.2), programme(1, 30, 1)),
      episode('b', programme(2, 30), advert(500, 1.2), programme(2, 30, 1)),
    ]);
    assert.deepEqual(result.copied, []);
  });

  it('is one row for an opener the host keeps in two versions differing in the last frame', () => {
    // RMC: 533 frames in each version, 532 in common, each version in four episodes.
    const head = advert(500, 13);
    const versionA = stitch(head, frame(900_001));
    const versionB = stitch(head, frame(900_002));
    const result = findCopiedAudio([
      episode('a1', versionA, programme(1, 200)),
      episode('a2', versionA, programme(2, 200)),
      episode('b1', versionB, programme(3, 200)),
      episode('b2', versionB, programme(4, 200)),
    ]);
    assert.equal(result.copied.length, 1, `one opener came back as ${result.copied.length} rows`);
    assert.equal(result.copied[0].episodeCount, 4);
    for (const o of result.copied[0].occurrences) assert.equal(o.startFrame, 0);
  });

  it('gives the same frames the same signature in whichever episode they are found', () => {
    const a = findCopiedAudio([episode('a', advert(500, 20), programme(1, 60)), episode('b', advert(500, 20), programme(2, 60))]);
    const b = findCopiedAudio([episode('x', programme(8, 30), advert(500, 20)), episode('y', advert(500, 20), programme(9, 60))]);
    assert.equal(a.copied[0].signature, b.copied[0].signature);
    assert.match(a.copied[0].signature, /^copied:[0-9a-f]{24}$/);
    assert.equal(signatureOf([1, 2, 3], 'break').slice(0, 6), 'break:');
  });
});

describe('breaks between the markers a host stitches around them', () => {
  /** Acast's shape: pre-roll, a mid-roll, a post-roll that runs to the end. */
  const acast = (n, preroll, midroll, postroll) =>
    episode(
      `e${n}`,
      preroll, MARKER(),
      programme(n, 600),
      MARKER(), midroll, MARKER(),
      programme(n, 600, 1),
      MARKER(), MARKER(), postroll,
    );

  it('cuts the breaks, markers included — even adverts heard nowhere else', () => {
    const result = findCopiedAudio([
      acast(1, advert(10_000, 30), advert(11_000, 60), advert(12_000, 40)),
      acast(2, advert(20_000, 45), advert(21_000, 30), advert(22_000, 35)),
    ]);
    assert.equal(result.markers.length, 1, 'the 2.2 s clip was not taken for a marker');
    const e1 = result.blocks.filter((b) => b.episodeId === 'e1').map((b) => [b.startFrame, b.endFrame]);
    const m = frames(2.2);
    const pre = frames(30) + m;
    const mid = [pre + frames(600), pre + frames(600) + m + frames(60) + m];
    const postFrom = mid[1] + frames(600);
    assert.deepEqual(e1, [[0, pre], mid, [postFrom, postFrom + 2 * m + frames(40)]]);
    for (const block of result.blocks) assert.match(block.signature, /^break:/);
    // One slot each, so the catalogue can keep a row per slot and a row is in each
    // episode once — which is what "Restore here" restores.
    assert.deepEqual(result.blocks.filter((b) => b.episodeId === 'e1').map((b) => b.slot), ['pre', 'mid-1', 'post']);
  });

  it('keeps the marker a marker when an advert next to it is copied too', () => {
    // Found on the real show: a 30 s advert copied with the marker beside it was folded
    // into the marker's row and stretched every marker to 33 seconds. It takes the
    // marker being in more episodes than the advert, as it was there — the row in more
    // episodes is the one others are folded into.
    const shared = advert(30_000, 30);
    const result = findCopiedAudio([
      acast(1, shared, advert(11_000, 60), advert(12_000, 40)),
      acast(2, shared, advert(21_000, 30), advert(22_000, 35)),
      acast(3, advert(31_000, 30), advert(32_000, 30), advert(33_000, 35)),
    ]);
    const marker = result.copied.find((row) => result.markers.includes(row.signature));
    assert.ok(marker, 'no marker row');
    for (const o of marker.occurrences) {
      assert.ok(o.endFrame - o.startFrame <= frames(2.2) + 1, `a marker occurrence is ${o.endMs - o.startMs} ms long`);
    }
  });

  it('says nothing about an episode with no stretch long enough to be the programme', () => {
    // A two-minute episode with markers in it cannot tell programme from break this way:
    // every stretch in it is short enough to be a break, so they add up to most of it.
    const short = episode('short', advert(10_000, 20), MARKER(), programme(1, 100), MARKER(), advert(11_000, 20));
    const other = episode('long', advert(20_000, 20), MARKER(), programme(2, 900), MARKER(), MARKER(), advert(21_000, 20));
    const result = findCopiedAudio([short, other]);
    assert.ok(result.markers.length, 'no marker');
    assert.deepEqual(result.blocks.filter((b) => b.episodeId === 'short'), []);
    assert.ok(result.blocks.some((b) => b.episodeId === 'long'));
  });

  it('never makes breaks of most of an episode', () => {
    // Markers close together everywhere but one long stretch: more break than programme.
    const parts = [];
    for (let i = 0; i < 12; i += 1) parts.push(advert(40_000 + i * 5_000, 100), MARKER());
    const busy = episode('busy', ...parts, programme(1, 200));
    const other = episode('other', MARKER(), programme(2, 900), MARKER());
    const result = findCopiedAudio([busy, other]);
    assert.deepEqual(result.blocks.filter((b) => b.episodeId === 'busy'), []);
  });

  it('does not take a short copy heard once per episode for a marker', () => {
    // An inserted ident at 0:00 of every episode is copied audio, not a slot edge.
    const result = findCopiedAudio([
      episode('a', advert(500, 3), programme(1, 600)),
      episode('b', advert(500, 3), programme(2, 600)),
      episode('c', advert(500, 3), programme(3, 600)),
    ]);
    assert.equal(result.copied.length, 1);
    assert.deepEqual(result.markers, []);
    assert.deepEqual(result.blocks, []);
  });
});
