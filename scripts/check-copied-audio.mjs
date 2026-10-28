#!/usr/bin/env node
/**
 * What the copied-audio search finds in a folder of real episodes.
 *
 *   node scripts/check-copied-audio.mjs <folder-of-mp3s> [--json]
 *
 * Runs `findCopiedAudio` exactly as the detector does, on files you downloaded from the
 * host yourself (not SelfPod's served copies, which are already cut). Prints every
 * stretch found in two or more episodes, which of them are slot markers, and the breaks
 * between markers — so a change to the search can be checked against real audio before
 * it is trusted with anyone's feed.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findCopiedAudio } from '../src/lib/copied-audio.js';
import { frameProfile } from '../src/lib/mp3-frames.js';

const args = process.argv.slice(2);
const folder = args.find((arg) => !arg.startsWith('--'));
if (!folder) {
  console.error('usage: node scripts/check-copied-audio.mjs <folder-of-mp3s> [--json]');
  process.exit(2);
}

const names = (await readdir(folder)).filter((name) => name.toLowerCase().endsWith('.mp3')).sort();
const episodes = [];
for (const name of names) {
  const profile = frameProfile(await readFile(join(folder, name)));
  if (!profile?.frameCount) {
    console.warn(`${name}: no MP3 frames, skipped`);
    continue;
  }
  episodes.push({ id: name, hashes: profile.hashes, frameMs: profile.durationMs / profile.frameCount, durationMs: profile.durationMs });
}

const started = Date.now();
const result = findCopiedAudio(episodes);
const elapsed = Date.now() - started;

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const seconds = (ms) => (ms / 1000).toFixed(1);
const durations = Object.fromEntries(episodes.map((episode) => [episode.id, episode.durationMs]));
const where = (o) => {
  const tail = durations[o.episodeId] - o.endMs < 1000 ? ' (to the end)' : '';
  return `${o.episodeId}@${seconds(o.startMs)}–${seconds(o.endMs)}${tail}`;
};

console.log(`${episodes.length} episodes, searched in ${elapsed} ms`);
console.log(`\nCopied stretches: ${result.copied.length}`);
for (const row of result.copied) {
  const marker = result.markers.includes(row.signature) ? ' [marker]' : '';
  console.log(`  ${seconds(row.durationMs)} s in ${row.episodeCount} episodes, ${row.occurrenceCount} times${marker}`);
  for (const o of row.occurrences) console.log(`      ${where(o)}`);
}
console.log(`\nBreaks between markers: ${result.blocks.length}`);
for (const block of result.blocks) console.log(`  ${where(block)}  (${seconds(block.endMs - block.startMs)} s)`);
