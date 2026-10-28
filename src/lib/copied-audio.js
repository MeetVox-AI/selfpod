import { createHash } from 'node:crypto';

/**
 * Finding audio a host spliced into a show, by its MP3 frames (spec §19.3).
 *
 * A host that inserts adverts as it serves does not re-encode the episode around them:
 * it concatenates frames from a file it already has. So the same advert lands in every
 * episode it is served with as the *same bytes*, while the programme — mastered and
 * encoded once per episode — never shares a frame with another episode. A theme tune
 * played in every episode is re-encoded every time and does not match here; an advert,
 * or an ident the host adds, always does.
 *
 * That makes byte-identical frames shared between two episodes the one signal that
 * tells an inserted stretch from a repeated part of the programme — which the acoustic
 * search (`repeated-audio.js`) cannot do, because a theme tune and an advert sound
 * equally alike from one episode to the next. Measured on 2026-10-28 from the UK:
 * Simplecast's RMC opener and closer were the same frames in 8 of 8 episodes; Acast's
 * pre-, mid- and post-rolls on Le Rendez-vous Tech were copied between episodes, and
 * a 2.2 s clip was stitched at the edge of every one of its blocks.
 *
 * Two answers come back:
 *
 * - **copied** — every stretch found in two or more episodes, with where it is.
 * - **blocks** — what lies between a host's slot markers. A short copied clip that
 *   turns up several times inside one episode is a marker the host stitches at the
 *   edge of each break; what sits between two of them, or between one and the edge of
 *   the file, is a break when it is short — including an advert never heard before.
 */

/** Shorter than this is a coincidence or a single repeated frame, not a file. */
export const MIN_COPIED_MS = 1500;

/** The longest a host's slot marker is taken to be. Acast's was 2.2 s. */
export const MAX_MARKER_MS = 5000;

/**
 * The longest stretch between markers that is called a break.
 *
 * The same figure `auto-approve.js` gives a difference between two downloads, for the
 * same reason: what lies between markers is chosen by whoever serves the file, and a
 * longer stretch is far more likely to be programme than a break.
 */
export const MAX_BLOCK_MS = 150_000;

/**
 * Below this share of distinct frames a stretch is silence or a held tone.
 *
 * Silence encodes to the same frame over and over, and two episodes that both contain a
 * second of it would otherwise "share" it.
 */
export const MIN_DISTINCT_FRACTION = 0.5;

/**
 * Only every STRIDE-th frame position goes into the index.
 *
 * A match of at least `MIN_COPIED_MS` is ~57 frames, so it always contains several
 * indexed positions, and scanning every position of the other side finds it. This cuts
 * the index sixteen-fold — a 100-minute episode is 230,000 frames, and a window of 28
 * of them is six million.
 */
const STRIDE = 16;

/**
 * A key indexed more often than this identifies nothing: silence, or a frame a whole
 * file is made of. Generous, because a marker is meant to recur — six times an episode
 * across 28 episodes is 168 occurrences, about ten of them indexed per key.
 */
const MAX_KEY_OCCURRENCES = 64;

/** Overlap past which a later find is the same stretch as an earlier one. */
const SAME_STRETCH = 0.9;

const POSITION_BITS = 2 ** 24;

/**
 * @param {Array<{id: string, hashes: Uint32Array|number[], frameMs: number}>} episodes
 *   `hashes` are `frameProfile(...).hashes`; `frameMs` is one frame's duration.
 * @param {{minCopiedMs?: number, maxMarkerMs?: number, maxBlockMs?: number}} [options]
 */
export function findCopiedAudio(episodes, options = {}) {
  const minCopiedMs = options.minCopiedMs ?? MIN_COPIED_MS;
  const maxMarkerMs = options.maxMarkerMs ?? MAX_MARKER_MS;
  const maxBlockMs = options.maxBlockMs ?? MAX_BLOCK_MS;

  const usable = episodes.filter((episode) => episode.hashes?.length && episode.frameMs > 0);
  if (usable.length < 2) return { copied: [], markers: [], blocks: [] };

  const index = buildIndex(usable);
  const claimed = usable.map(() => []);
  const rows = [];

  for (let e = 0; e < usable.length; e += 1) {
    const a = usable[e].hashes;
    const minFrames = Math.ceil(minCopiedMs / usable[e].frameMs);
    for (let i = 0; i < a.length; i += 1) {
      const claim = claimAt(claimed[e], i);
      if (claim) {
        i = claim.end - 1;
        continue;
      }
      const run = longestPartnerRun(usable, index, e, i);
      if (!run || run.end - run.start < minFrames) continue;

      const content = a.subarray ? a.subarray(run.start, run.end) : a.slice(run.start, run.end);
      if (distinctFraction(content) < MIN_DISTINCT_FRACTION) {
        // Claimed all the same, so the scan does not test every frame of it again.
        claimed[e].push({ start: run.start, end: run.end });
        i = run.end - 1;
        continue;
      }
      const occurrences = occurrencesOf(usable, index, content);
      for (const occurrence of occurrences) claimed[occurrence.e].push({ start: occurrence.start, end: occurrence.end });
      if (new Set(occurrences.map((o) => o.e)).size >= 2) {
        rows.push({ signature: signatureOf(content), frameCount: content.length, content, occurrences });
      }
      i = run.end - 1;
    }
  }

  const copied = foldOverlapping(rows).map((row) => describeRow(row, usable));
  const markers = copied.filter((row) => isMarker(row, maxMarkerMs));
  const blocks = blocksBetween(markers, usable, maxBlockMs);
  return { copied, markers: markers.map((row) => row.signature), blocks };
}

function buildIndex(usable) {
  const index = new Map();
  usable.forEach((episode, e) => {
    const hashes = episode.hashes;
    for (let i = 0; i < hashes.length; i += STRIDE) {
      const key = hashes[i];
      const at = index.get(key);
      if (at) {
        if (at.length <= MAX_KEY_OCCURRENCES) at.push(e * POSITION_BITS + i);
      } else index.set(key, [e * POSITION_BITS + i]);
    }
  });
  // Left in the map but marked: a key past the cap is never looked up again.
  for (const [key, at] of index) if (at.length > MAX_KEY_OCCURRENCES) index.set(key, null);
  return index;
}

function unpack(packed) {
  const e = Math.floor(packed / POSITION_BITS);
  return { e, at: packed - e * POSITION_BITS };
}

function claimAt(claims, i) {
  for (const claim of claims) if (i >= claim.start && i < claim.end) return claim;
  return null;
}

/** The longest exact run through frame `i` of episode `e` shared with another episode. */
function longestPartnerRun(usable, index, e, i) {
  const a = usable[e].hashes;
  const hits = index.get(a[i]);
  if (!hits) return null;
  let best = null;
  for (const packed of hits) {
    const { e: o, at: j } = unpack(packed);
    if (o === e) continue;
    const b = usable[o].hashes;
    let back = 0;
    while (i - back - 1 >= 0 && j - back - 1 >= 0 && a[i - back - 1] === b[j - back - 1]) back += 1;
    let forward = 1;
    while (i + forward < a.length && j + forward < b.length && a[i + forward] === b[j + forward]) forward += 1;
    const run = { start: i - back, end: i + forward };
    if (!best || run.end - run.start > best.end - best.start) best = run;
  }
  return best;
}

/** Every place `content` occurs, byte for byte, in any episode — its own included. */
function occurrencesOf(usable, index, content) {
  const seen = new Set();
  const found = [];
  const probes = Math.min(STRIDE, content.length);
  for (let k = 0; k < probes; k += 1) {
    const hits = index.get(content[k]);
    if (!hits) continue;
    for (const packed of hits) {
      const { e, at } = unpack(packed);
      const start = at - k;
      const id = e * POSITION_BITS + start;
      if (start < 0 || seen.has(id)) continue;
      seen.add(id);
      const hashes = usable[e].hashes;
      if (start + content.length > hashes.length) continue;
      let same = true;
      for (let n = 0; n < content.length; n += 1) {
        if (hashes[start + n] !== content[n]) {
          same = false;
          break;
        }
      }
      if (same) found.push({ e, start, end: start + content.length });
    }
  }
  return found.sort((x, y) => x.e - y.e || x.start - y.start);
}

/**
 * One stretch, one row.
 *
 * Two ways one advert is found twice, both seen on the real RMC show:
 *
 * - **Where it is.** Two episodes share one frame more of an opener than the rest
 *   do, and the longer run is found first. Its occurrences sit on top of the shorter
 *   row's in the same episodes.
 * - **What it is.** The host keeps two versions of the opener whose last frame differs
 *   — 533 frames each, 532 in common. Each version is exact in its own four episodes,
 *   so the two rows never share an episode and only their frames show they are one.
 *
 * Either way, "the same" means at least nine-tenths of the *longer* of the two: a
 * two-second marker stitched beside a thirty-second advert overlaps it completely, and
 * folding them would stretch the marker to the advert's length.
 */
function foldOverlapping(rows) {
  const sorted = [...rows].sort(
    (x, y) => episodeCount(y) - episodeCount(x) || y.frameCount - x.frameCount,
  );
  const kept = [];
  for (const row of sorted) {
    const byPlace = kept.find((candidate) =>
      row.occurrences.every((occurrence) =>
        candidate.occurrences.some(
          (other) =>
            other.e === occurrence.e &&
            Math.min(other.end, occurrence.end) - Math.max(other.start, occurrence.start) >=
              SAME_STRETCH * Math.max(other.end - other.start, occurrence.end - occurrence.start),
        ),
      ),
    );
    if (byPlace) {
      for (const occurrence of row.occurrences) {
        const other = byPlace.occurrences.find(
          (o) => o.e === occurrence.e && Math.min(o.end, occurrence.end) > Math.max(o.start, occurrence.start),
        );
        other.start = Math.min(other.start, occurrence.start);
        other.end = Math.max(other.end, occurrence.end);
      }
      continue;
    }
    const byContent = kept.find(
      (candidate) =>
        longestCommonRun(candidate.content, row.content) >= SAME_STRETCH * Math.max(candidate.frameCount, row.frameCount),
    );
    if (byContent) {
      for (const occurrence of row.occurrences) {
        const clash = byContent.occurrences.some(
          (o) => o.e === occurrence.e && Math.min(o.end, occurrence.end) > Math.max(o.start, occurrence.start),
        );
        if (!clash) byContent.occurrences.push({ ...occurrence });
      }
      continue;
    }
    kept.push({ ...row, occurrences: row.occurrences.map((o) => ({ ...o })) });
  }
  return kept;
}

/** The longest stretch of frames two contents have in common, at any offset. */
function longestCommonRun(a, b) {
  const positions = new Map();
  for (let i = 0; i < a.length; i += 1) {
    const at = positions.get(a[i]);
    if (at) at.push(i);
    else positions.set(a[i], [i]);
  }
  let best = 0;
  const tried = new Set();
  for (let j = 0; j < b.length; j += 1) {
    for (const i of positions.get(b[j]) ?? []) {
      const diagonal = i - j;
      if (tried.has(diagonal)) continue;
      tried.add(diagonal);
      let run = 0;
      for (let n = Math.max(0, -diagonal); n < b.length && n + diagonal < a.length; n += 1) {
        if (a[n + diagonal] === b[n]) {
          run += 1;
          if (run > best) best = run;
        } else run = 0;
      }
    }
  }
  return best;
}

function episodeCount(row) {
  return new Set(row.occurrences.map((o) => o.e)).size;
}

function describeRow(row, usable) {
  const occurrences = row.occurrences.map((o) => ({
    episodeId: usable[o.e].id,
    startFrame: o.start,
    endFrame: o.end,
    startMs: Math.round(o.start * usable[o.e].frameMs),
    endMs: Math.round(o.end * usable[o.e].frameMs),
  }));
  const frameMs = usable[row.occurrences[0].e].frameMs;
  return {
    signature: row.signature,
    durationMs: Math.round(row.frameCount * frameMs),
    episodeCount: new Set(occurrences.map((o) => o.episodeId)).size,
    occurrenceCount: occurrences.length,
    occurrences,
  };
}

/** Short, and found more than once inside a single episode. */
function isMarker(row, maxMarkerMs) {
  if (row.durationMs > maxMarkerMs) return false;
  const perEpisode = new Map();
  for (const o of row.occurrences) perEpisode.set(o.episodeId, (perEpisode.get(o.episodeId) ?? 0) + 1);
  return [...perEpisode.values()].some((count) => count >= 2);
}

/**
 * The stretches between markers that are short enough to be a break.
 *
 * What makes the short stretches breaks is the long ones: programme runs for many
 * minutes between breaks. An episode where the short stretches would add up to most of
 * it — a two-minute episode with markers in it, say, whose programme is itself shorter
 * than a break — cannot tell the two apart this way, and nothing is said about it.
 */
function blocksBetween(markers, usable, maxBlockMs) {
  const byEpisode = new Map();
  for (const marker of markers) {
    for (const o of marker.occurrences) {
      if (!byEpisode.has(o.episodeId)) byEpisode.set(o.episodeId, []);
      byEpisode.get(o.episodeId).push(o);
    }
  }
  const blocks = [];
  for (const episode of usable) {
    const marks = mergeRanges(byEpisode.get(episode.id) ?? []);
    if (!marks.length) continue;
    const total = episode.hashes.length;
    const maxFrames = Math.floor(maxBlockMs / episode.frameMs);
    const gaps = [];
    let from = 0;
    for (const mark of marks) {
      gaps.push({ start: from, end: mark.startFrame });
      from = mark.endFrame;
    }
    gaps.push({ start: from, end: total });

    const breaks = gaps.filter((gap) => gap.end - gap.start > 0 && gap.end - gap.start <= maxFrames);
    const cutFrames = breaks.reduce((sum, gap) => sum + gap.end - gap.start, 0);
    // Never most of an episode, whatever the markers say: that is an episode whose
    // programme is no longer than its breaks, or markers that are not a host's.
    if (cutFrames > total / 2) continue;

    /*
     * A break is reported with the markers around it, and breaks that touch are one.
     * Acast stitched two markers back to back with a tenth of a second between them;
     * reported apart, that is three pieces on the page for one break, and the tenth of
     * a second is a click left in the episode if any piece is restored on its own.
     */
    const pieces = [...breaks, ...marks.map((mark) => ({ start: mark.startFrame, end: mark.endFrame, marker: true }))]
      .sort((x, y) => x.start - y.start);
    const joined = [];
    for (const piece of pieces) {
      const last = joined[joined.length - 1];
      if (last && piece.start <= last.end) {
        last.end = Math.max(last.end, piece.end);
        last.breaks += piece.marker ? 0 : 1;
      } else joined.push({ start: piece.start, end: piece.end, breaks: piece.marker ? 0 : 1 });
    }
    const middle = joined.filter((range) => range.breaks && range.start > 0 && range.end < total);
    for (const range of joined) {
      // A marker on its own is already a copied stretch; only a break is new here.
      if (!range.breaks) continue;
      // Which break of the episode this is: the catalogue keeps one row per slot, so a
      // row is in each episode at most once and "Restore here" means one break.
      const slot = range.start === 0 ? 'pre' : range.end >= total ? 'post' : `mid-${middle.indexOf(range) + 1}`;
      const content = episode.hashes.subarray
        ? episode.hashes.subarray(range.start, range.end)
        : episode.hashes.slice(range.start, range.end);
      blocks.push({
        signature: signatureOf(content, 'break'),
        slot,
        episodeId: episode.id,
        startFrame: range.start,
        endFrame: range.end,
        startMs: Math.round(range.start * episode.frameMs),
        endMs: Math.round(range.end * episode.frameMs),
      });
    }
  }
  return blocks;
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((x, y) => x.startFrame - y.startFrame);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, range.endFrame);
    else merged.push({ startFrame: range.startFrame, endFrame: range.endFrame });
  }
  return merged;
}

function distinctFraction(content) {
  if (!content.length) return 0;
  return new Set(content).size / content.length;
}

/** The same frames give the same signature, in whichever episode they are found. */
export function signatureOf(content, prefix = 'copied') {
  const hash = createHash('sha256');
  const bytes = Buffer.alloc(content.length * 4);
  for (let n = 0; n < content.length; n += 1) bytes.writeUInt32BE(content[n] >>> 0, n * 4);
  return `${prefix}:${hash.update(bytes).digest('hex').slice(0, 24)}`;
}
