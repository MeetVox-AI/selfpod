import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CUE_STRONG } from '../../src/constants.js';
import { safeToApproveAutomatically } from '../../src/lib/auto-approve.js';

const durations = { a: 600_000, b: 600_000, c: 600_000 };

function segment({ episodes = ['a', 'b', 'c'], startMs = 120_000, durationMs = 30_000, cueScore = 0 } = {}) {
  return {
    durationMs,
    cueScore,
    episodeCount: episodes.length,
    occurrences: episodes.map((episodeId) => ({ episodeId, startMs, endMs: startMs + durationMs })),
  };
}

describe('a segment found by the words', () => {
  const options = { episodeDurations: durations, minEpisodes: 3, source: 'transcript' };

  it('is never cut on its own when heard once, however it sounds', () => {
    const verdict = safeToApproveAutomatically(segment({ episodes: ['a'], cueScore: 1 }), options);
    assert.deepEqual(verdict, { safe: false, reason: 'only_heard_once' });
  });

  it('is cut after two hearings when the words say sponsor, below the usual threshold', () => {
    const verdict = safeToApproveAutomatically(segment({ episodes: ['a', 'b'], cueScore: CUE_STRONG }), options);
    assert.deepEqual(verdict, { safe: true, reason: null });
  });

  it('waits for the usual number of episodes when the words say nothing', () => {
    const verdict = safeToApproveAutomatically(segment({ episodes: ['a', 'b'], cueScore: 0.2 }), options);
    assert.deepEqual(verdict, { safe: false, reason: 'seen_too_few_times' });
  });

  it('lets sponsor wording at the very start through, and holds a standing intro there', () => {
    const preRoll = segment({ startMs: 0, cueScore: 1 });
    assert.deepEqual(safeToApproveAutomatically(preRoll, options), { safe: true, reason: null });
    const intro = segment({ startMs: 0, cueScore: 0 });
    assert.deepEqual(safeToApproveAutomatically(intro, options), { safe: false, reason: 'always_at_the_start' });
  });

  it('holds a repeated tag at the very end when nothing in it sounds like an advert', () => {
    const outro = segment({ startMs: 590_000, durationMs: 8_000, cueScore: 0 });
    assert.deepEqual(safeToApproveAutomatically(outro, options), { safe: false, reason: 'always_at_the_end' });
  });

  it('keeps the length limits, with a shorter floor than the acoustic branch', () => {
    assert.equal(safeToApproveAutomatically(segment({ durationMs: 4_000, cueScore: 1 }), options).reason, 'too_short_to_be_an_advert');
    assert.equal(safeToApproveAutomatically(segment({ durationMs: 7_000, cueScore: 1 }), options).safe, true);
    assert.equal(safeToApproveAutomatically(segment({ durationMs: 200_000, cueScore: 1 }), options).reason, 'too_long_to_be_an_advert');
  });
});

describe('a segment found by ear, once the words are known', () => {
  const options = { episodeDurations: durations, minEpisodes: 3, source: 'corpus' };

  it('is released from the theme-tune guard by sponsor wording, and only by that', () => {
    const preRoll = segment({ startMs: 0, cueScore: 1 });
    assert.deepEqual(safeToApproveAutomatically(preRoll, options), { safe: true, reason: null });
    const theme = segment({ startMs: 0 });
    assert.deepEqual(safeToApproveAutomatically(theme, options), { safe: false, reason: 'always_at_the_start' });
  });
});

describe('audio the host inserted, found by its frames', () => {
  // RMC's real opener: 13.9 s at 0:00 of every episode. The acoustic branch refuses it
  // twice over — at the start, and under fifteen seconds — and is right to: a theme tune
  // has exactly that shape. Copied frames are what tell the two apart.
  const opener = () => segment({ startMs: 0, durationMs: 13_900 });

  it('cuts an opener at 0:00 that the acoustic branch would hold as a theme tune', () => {
    assert.equal(safeToApproveAutomatically(opener(), { episodeDurations: durations }).safe, false);
    assert.deepEqual(safeToApproveAutomatically(opener(), { source: 'inserted' }), { safe: true, reason: null });
  });

  it('cuts a closer of ten seconds, under the acoustic floor', () => {
    const closer = segment({ startMs: 590_000, durationMs: 10_100 });
    assert.equal(safeToApproveAutomatically(closer, { source: 'inserted' }).safe, true);
  });

  it('offers a copy in exactly two episodes, mid-file — a best-of may reuse programme so', () => {
    const twice = segment({ episodes: ['a', 'b'], startMs: 200_000, durationMs: 45_000 });
    assert.deepEqual(
      safeToApproveAutomatically(twice, { source: 'inserted', episodeDurations: durations }),
      { safe: false, reason: 'seen_too_few_times' },
    );
  });

  it('cuts a copy in two episodes where a host puts one: the very start, or the very end', () => {
    const preRoll = segment({ episodes: ['a', 'b'], startMs: 0, durationMs: 30_000 });
    const postRoll = segment({ episodes: ['a', 'b'], startMs: 570_000, durationMs: 30_000 });
    for (const copy of [preRoll, postRoll]) {
      assert.equal(safeToApproveAutomatically(copy, { source: 'inserted', episodeDurations: durations }).safe, true);
    }
  });

  it('offers a copy in two episodes at their edges when it runs over a minute', () => {
    // A recap or a reused segment opening one episode and closing another.
    const long = segment({ episodes: ['a', 'b'], startMs: 0, durationMs: 90_000 });
    assert.deepEqual(
      safeToApproveAutomatically(long, { source: 'inserted', episodeDurations: durations }),
      { safe: false, reason: 'seen_too_few_times' },
    );
  });

  it('cuts a copy mid-file once it reaches a third episode', () => {
    const thrice = segment({ episodes: ['a', 'b', 'c'], startMs: 200_000, durationMs: 45_000 });
    assert.equal(safeToApproveAutomatically(thrice, { source: 'inserted', episodeDurations: durations }).safe, true);
  });

  it('holds a copy that is not really in two episodes', () => {
    const once = segment({ episodes: ['a'], startMs: 0, durationMs: 20_000 });
    assert.deepEqual(safeToApproveAutomatically(once, { source: 'inserted' }), { safe: false, reason: 'only_heard_once' });
  });

  it('cuts a break between markers, whose markers are its evidence', () => {
    const block = { durationMs: 72_300, episodeCount: 1, betweenMarkers: true };
    assert.equal(safeToApproveAutomatically(block, { source: 'inserted' }).safe, true);
  });

  it('holds anything longer than two and a half minutes, however it was found', () => {
    for (const evidence of [segment({ durationMs: 151_000 }), { durationMs: 151_000, episodeCount: 1, betweenMarkers: true }]) {
      assert.deepEqual(safeToApproveAutomatically(evidence, { source: 'inserted' }), { safe: false, reason: 'too_long_to_be_an_advert' });
    }
  });
});
