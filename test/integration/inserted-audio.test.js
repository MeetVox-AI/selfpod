import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SEGMENT_KINDS, SEGMENT_STATUS } from '../../src/constants.js';
import { frameProfile } from '../../src/lib/mp3-frames.js';
import { createTestServer } from '../helpers/http.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

/**
 * Audio a host inserts as it serves, through the whole app: files in a show folder, the
 * scan, a pass of the advert pipeline, and the audio a podcast app is then given.
 *
 * The shapes are the two real hosts measured on 2026-10-28 (spec §19.3): RMC on
 * Simplecast, with the same opener and closer spliced into every episode; Acast, with a
 * 2.2 s marker around every break, and adverts in the breaks that no other episode had.
 * Frame numbers are spaced so that no two parts share a frame by accident.
 */
const frames = (seconds) => Math.round((seconds * 1000) / FRAME_MS);
const programme = (n, seconds, part = 0) => segment(1_000_000 + n * 100_000 + part * 50_000, frames(seconds));
const advert = (k, seconds) => segment(k * 10_000, frames(seconds));
const MARKER = () => advert(7, 2.2);

let server;
let showDir;

beforeEach(async () => {
  server = await createTestServer();
  showDir = await server.makeShowFolder('chroniques');
});

afterEach(async () => {
  await server.cleanup();
});

async function makeShow(mode, files) {
  await writeFile(join(showDir, '.keep'), '');
  await server.scanner.scanAllNow('manual');
  const created = server.shows.getBySlug('chroniques');
  server.db.prepare('UPDATE shows SET ad_trim_mode = ? WHERE id = ?').run(mode, created.id);
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(showDir, name), bytes);
  await server.scanner.scanAllNow('manual');
  return server.shows.get(created.id);
}

/** What a podcast app is given for an episode, at the address the feed advertises. */
async function served(show, filename) {
  const episode = server.episodes.listByShow(show.id).find((row) => row.filename === filename);
  const version = episode.trimmed_etag ? `?v=${episode.trimmed_etag}` : '';
  const response = await server.app.inject({
    method: 'GET',
    url: `/media/${show.slug}/${show.feed_token}/${episode.id}/${encodeURIComponent(filename)}${version}`,
  });
  assert.equal(response.statusCode, 200);
  return [...frameProfile(response.rawPayload).hashes];
}

const hashesOf = (...parts) => [...frameProfile(stitch(...parts)).hashes];

const rows = (show) => server.adDetect.listSegments(show.id).filter((row) => row.status !== SEGMENT_STATUS.REJECTED);

describe('an opener and a closer the host splices into every episode', () => {
  // RMC: the same 14 s opener at 0:00 and 10 s closer at the end, in every episode.
  const rmc = (n) => stitch(advert(1, 14), programme(n, 200), advert(2, 10));
  const files = { 'a.mp3': rmc(1), 'b.mp3': rmc(2), 'c.mp3': rmc(3) };

  it('is cut from every episode, exactly, leaving exactly the programme', async () => {
    const show = await makeShow('auto', files);
    await server.adPipeline.processShow(show.id);

    for (const [n, name] of [[1, 'a.mp3'], [2, 'b.mp3'], [3, 'c.mp3']]) {
      assert.deepEqual(await served(show, name), hashesOf(programme(n, 200)), `${name} is not exactly its programme`);
    }
    const inserted = rows(show).filter((row) => row.kind === SEGMENT_KINDS.INSERTED);
    assert.equal(inserted.length, 2, 'the opener and the closer, one row each');
    for (const row of inserted) {
      assert.equal(row.status, SEGMENT_STATUS.APPROVED);
      assert.equal(row.auto_approved, 1);
      assert.equal(row.episode_count, 3);
    }
  });

  it('is not offered again as "audio this show repeats" beside the row that cuts it', async () => {
    // The acoustic search hears the same opener in all three episodes too. Before, it
    // was the only thing that did, and held it as a theme tune at 0:00.
    const show = await makeShow('auto', files);
    await server.adPipeline.processShow(show.id);

    const others = rows(show).filter((row) => row.kind !== SEGMENT_KINDS.INSERTED && row.occurrences.length);
    assert.deepEqual(
      others.map((row) => `${row.kind} ${row.duration_ms} ms`),
      [],
      'the inserted audio came back as a second row',
    );
  });

  it('is only offered, and nothing cut, while the show is set to review', async () => {
    const show = await makeShow('review', files);
    await server.adPipeline.processShow(show.id);

    const inserted = rows(show).filter((row) => row.kind === SEGMENT_KINDS.INSERTED);
    assert.equal(inserted.length, 2);
    for (const row of inserted) assert.equal(row.status, SEGMENT_STATUS.CANDIDATE);
    assert.ok(server.episodes.listByShow(show.id).every((row) => !row.trimmed_etag), 'something was cut unasked');
  });

  it('stays out of one episode the owner restored it in, and only that one', async () => {
    const show = await makeShow('auto', files);
    await server.adPipeline.processShow(show.id);
    const opener = rows(show).find((row) => row.kind === SEGMENT_KINDS.INSERTED && row.occurrences[0].start_ms === 0);
    const b = server.episodes.listByShow(show.id).find((row) => row.filename === 'b.mp3');

    server.adDetect.restoreHere({ segmentId: opener.id, episodeId: b.id });
    await server.adPipeline.processShow(show.id);
    await server.adPipeline.processShow(show.id);

    assert.deepEqual(await served(show, 'b.mp3'), hashesOf(advert(1, 14), programme(2, 200)), 'the restore did not hold');
    assert.deepEqual(await served(show, 'a.mp3'), hashesOf(programme(1, 200)), 'the restore leaked to another episode');
  });

  it('is not looked for again on a pass where nothing changed', async () => {
    // Detection counts as an owner's action unless it is declared read-only, and an
    // owner's action means "look again next pass" — for ever, on every pass.
    const show = await makeShow('auto', files);
    await server.adPipeline.processShow(show.id);
    await server.adPipeline.processShow(show.id);
    const searches = server.adDetect.workDone().corpusSearches;

    await server.adPipeline.processShow(show.id);

    assert.equal(server.adDetect.workDone().corpusSearches, searches, 'an unchanged show was searched again');
  });

  it('marks a followed feed as one whose host inserts audio', async () => {
    const show = await makeShow('auto', files);
    server.db
      .prepare(
        `INSERT INTO feed_subscriptions (id, show_id, feed_url, created_at, updated_at)
         VALUES ('sub', ?, 'https://feeds.example.com/chroniques.xml', 'x', 'x')`,
      )
      .run(show.id);
    await server.adPipeline.processShow(show.id);
    assert.equal(server.db.prepare(`SELECT inserts_audio FROM feed_subscriptions WHERE id = 'sub'`).get().inserts_audio, 1);
  });
});

describe('breaks between the markers a host stitches around them', () => {
  // Acast: a different advert in every break, a marker at every edge, two markers back
  // to back where the post-roll starts.
  const acast = (n) =>
    stitch(
      advert(100 + n * 10, 30), MARKER(),
      programme(n, 240),
      MARKER(), advert(101 + n * 10, 30), MARKER(),
      programme(n, 240, 1),
      MARKER(), MARKER(), advert(102 + n * 10, 25),
    );

  it('cuts every break, markers included, though no advert in them was heard twice', async () => {
    const show = await makeShow('auto', { 'a.mp3': acast(1), 'b.mp3': acast(2), 'c.mp3': acast(3) });
    await server.adPipeline.processShow(show.id);

    for (const [n, name] of [[1, 'a.mp3'], [2, 'b.mp3'], [3, 'c.mp3']]) {
      assert.deepEqual(
        await served(show, name),
        hashesOf(programme(n, 240), programme(n, 240, 1)),
        `${name} is not exactly its programme`,
      );
    }
    const slots = rows(show)
      .filter((row) => row.signature.startsWith('break:'))
      .map((row) => [row.signature, row.episode_count, row.occurrences.length]);
    assert.deepEqual(slots.sort(), [['break:mid-1', 3, 3], ['break:post', 3, 3], ['break:pre', 3, 3]]);
  });
});

describe('a library fingerprinted before frame hashes were kept', () => {
  // Every episode already on an owner's NAS: fingerprinted by 1.10, with no frame-hash
  // file beside its fingerprint. Decoding them all again would be a minute a NAS episode.
  const rmc = (n) => stitch(advert(1, 14), programme(n, 200), advert(2, 10));
  const frameFiles = async (show) =>
    (await readdir(join(server.config.fingerprintDir, show.id))).filter((name) => name.endsWith('.frames'));

  it('reads the hashes from the files once, without fingerprinting them again, and cuts', async () => {
    const show = await makeShow('review', { 'a.mp3': rmc(1), 'b.mp3': rmc(2), 'c.mp3': rmc(3) });
    await server.adPipeline.processShow(show.id);
    for (const name of await frameFiles(show)) await rm(join(server.config.fingerprintDir, show.id, name));
    server.db.prepare('DELETE FROM ad_segments WHERE show_id = ?').run(show.id);
    const computed = server.adDetect.workDone().fingerprintsComputed;

    const found = await server.adDetect.detectCopiedAudio(show.id);

    assert.equal(found.segments, 2, 'the opener and the closer were not found from the files');
    assert.equal((await frameFiles(show)).length, 3, 'the hashes were not kept');
    assert.equal(server.adDetect.workDone().fingerprintsComputed, computed, 'it decoded the episodes again');
  });

  it('does not trust a file that changed since its fingerprint', async () => {
    const show = await makeShow('review', { 'a.mp3': rmc(1), 'b.mp3': rmc(2) });
    await server.adPipeline.processShow(show.id);
    for (const name of await frameFiles(show)) await rm(join(server.config.fingerprintDir, show.id, name));
    server.db.prepare('DELETE FROM ad_segments WHERE show_id = ?').run(show.id);
    // Replaced on the share, and no pass has fingerprinted it since.
    await writeFile(join(showDir, 'b.mp3'), stitch(programme(9, 200)));

    const found = await server.adDetect.detectCopiedAudio(show.id);

    assert.equal(found.skipped, 'not_enough_episodes', 'hashes of the new file were paired with the old fingerprint');
  });
});

describe('what the copied frames must not cut unasked', () => {
  it('offers a stretch of programme two episodes share mid-file, and cuts nothing', async () => {
    // A "best of" assembled from an earlier episode's file without re-encoding shares a
    // stretch of programme with that episode, byte for byte, in the middle of both.
    const clip = programme(9, 45);
    const show = await makeShow('auto', {
      'original.mp3': stitch(programme(1, 120), clip, programme(1, 120, 1)),
      'best-of.mp3': stitch(programme(2, 60), clip, programme(2, 60, 1)),
      'other.mp3': stitch(programme(3, 200)),
    });
    await server.adPipeline.processShow(show.id);

    const [row] = rows(show).filter((r) => r.kind === SEGMENT_KINDS.INSERTED);
    assert.ok(row, 'the shared stretch was not found at all');
    assert.equal(row.status, SEGMENT_STATUS.CANDIDATE);
    assert.equal(row.hold_reason, 'seen_too_few_times');
    assert.ok(server.episodes.listByShow(show.id).every((e) => !e.trimmed_etag), 'programme was cut unasked');
  });

  it('leaves alone what the owner already removed by ear, and asks nothing new about it', async () => {
    // An owner in review mode who removed a read before this search existed. The cut
    // they approved goes on cutting, and the same audio is not offered a second time —
    // which would hold every episode back until it was answered again.
    const read = advert(3, 40);
    const files = {
      'a.mp3': stitch(programme(1, 45), read, programme(1, 45, 1)),
      'b.mp3': stitch(programme(2, 45), read, programme(2, 45, 1)),
      'c.mp3': stitch(programme(3, 45), read, programme(3, 45, 1)),
    };
    const show = await makeShow('review', files);
    await server.adDetect.fingerprintShow(show.id);
    await server.adDetect.detectForShow(show.id);
    const [byEar] = rows(show).filter((r) => r.kind === SEGMENT_KINDS.REPEATED_AUDIO);
    assert.ok(byEar, 'the acoustic search did not find the read');
    server.adDetect.decide(byEar.id, SEGMENT_STATUS.APPROVED);

    await server.adPipeline.processShow(show.id);
    await server.adPipeline.processShow(show.id);

    assert.deepEqual(rows(show).filter((r) => r.kind === SEGMENT_KINDS.INSERTED), [], 'the same audio was offered twice');
    assert.ok(server.episodes.listByShow(show.id).every((e) => e.publish_hold === null), 'an episode is held for a question already answered');
    const stillCutting = server.adDetect.listSegments(show.id).find((r) => r.id === byEar.id);
    assert.equal(stillCutting.occurrences.length, 3, 'the approved cut lost its occurrences to a row nobody approved');
    const cut = server.adDetect.cutListFor(server.episodes.listByShow(show.id).find((e) => e.filename === 'a.mp3').id);
    assert.ok(cut.length >= 1, 'the read is no longer cut');
  });
});

describe('a cut the owner approved, beside a copied row still waiting', () => {
  it('keeps cutting, even where the waiting row covers it', async () => {
    // Reached when the two overlap only in part — the copied row is wider than what the
    // ear found — so the copied search does write its row, and it waits to be asked.
    const read = advert(3, 40);
    const show = await makeShow('review', {
      'a.mp3': stitch(programme(1, 45), read, programme(1, 45, 1)),
      'b.mp3': stitch(programme(2, 45), read, programme(2, 45, 1)),
      'c.mp3': stitch(programme(3, 45), read, programme(3, 45, 1)),
    });
    await server.adDetect.fingerprintShow(show.id);
    await server.adDetect.detectForShow(show.id);
    const [byEar] = rows(show).filter((r) => r.kind === SEGMENT_KINDS.REPEATED_AUDIO);
    server.adDetect.decide(byEar.id, SEGMENT_STATUS.APPROVED);

    // A waiting copied row a quarter-minute wider each side than the read.
    const id = 'waiting-copy';
    server.db
      .prepare(
        `INSERT INTO ad_segments (id, show_id, signature, source, status, duration_ms, episode_count, occurrence_count,
           first_seen_at, created_at, updated_at, kind)
         VALUES (?, ?, 'copied:wider', 'corpus', 'candidate', 70000, 3, 3, 'x', 'x', 'x', 'inserted')`,
      )
      .run(id, show.id);
    const pad = frames(15);
    for (const e of server.episodes.listByShow(show.id)) {
      server.db
        .prepare(
          `INSERT INTO ad_segment_occurrences (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, e.id, frames(45) - pad, frames(85) + pad, 30_000, 100_000);
    }

    await server.adDetect.detectForShow(show.id);

    const after = server.adDetect.listSegments(show.id).find((r) => r.id === byEar.id);
    assert.equal(after.occurrences.length, 3, 'the approved cut lost its occurrences to a row nobody approved');
  });
});

describe('copies inside a break', () => {
  it('are cut with the break, not offered again as rows of their own', async () => {
    // Acast serves the same advert to two episodes now and then; inside a break it is
    // already cut, and a row of its own would wait to be asked about and hold them back.
    // In the mid-roll: mid-file and in two episodes, the shape that is only offered.
    const shared = advert(5, 30);
    const acastWith = (n, midroll) =>
      stitch(advert(100 + n * 10, 30), MARKER(), programme(n, 240), MARKER(), midroll, MARKER(), programme(n, 240, 1), MARKER(), MARKER(), advert(102 + n * 10, 25));
    const show = await makeShow('auto', {
      'a.mp3': acastWith(1, shared),
      'b.mp3': acastWith(2, shared),
      'c.mp3': acastWith(3, advert(130, 30)),
    });
    await server.adPipeline.processShow(show.id);

    const inserted = rows(show).filter((r) => r.kind === SEGMENT_KINDS.INSERTED);
    assert.ok(inserted.every((r) => r.signature.startsWith('break:') || r.status === SEGMENT_STATUS.APPROVED), inserted.map((r) => `${r.signature} ${r.status}`).join('; '));
    assert.equal(inserted.filter((r) => r.status === SEGMENT_STATUS.CANDIDATE).length, 0);
    assert.ok(server.episodes.listByShow(show.id).every((e) => e.publish_hold === null), 'an episode is held');
  });
});

describe('a theme copied into some episodes and re-encoded in another', () => {
  // Acceptance step 22's files: the same 48k theme bytes in two episodes, an 80k encode
  // of it in the third. Heard in all three, and the copied row explains only two.
  const fixture = (name) => readFileSync(join(import.meta.dirname, '../fixtures/audio', name));

  it('is still found by ear in all three', async () => {
    const [a, b, c, t48, t80] = ['prog-a.mp3', 'prog-b.mp3', 'prog-c.mp3', 'theme-48k.mp3', 'theme-80k.mp3'].map(fixture);
    const show = await makeShow('review', {
      'part-1.mp3': stitch(a, t48, b),
      'part-2.mp3': stitch(b, t48, c),
      'part-3.mp3': stitch(c, t80, a),
    });
    server.db.prepare('UPDATE shows SET ad_auto_min_episodes = 2 WHERE id = ?').run(show.id);
    await server.adPipeline.processShow(show.id);

    const byEar = rows(show).filter((r) => r.kind === SEGMENT_KINDS.REPEATED_AUDIO && r.duration_ms >= 4000);
    const best = byEar.sort((x, y) => y.episode_count - x.episode_count)[0];
    assert.ok(best, `nothing found by ear: ${rows(show).map((r) => `${r.kind} ${r.episode_count}`).join(', ')}`);
    assert.equal(best.episode_count, 3);
    assert.ok(best.duration_ms >= 4500 && best.duration_ms <= 8000, `${best.duration_ms} ms`);
  });
});

describe('a show whose own theme follows a spoken intro', () => {
  /*
   * Le Rendez-vous Tech on Acast, 2026-10-28: pre-roll, marker, then the host's spoken
   * intro ("Aujourd'hui on va parler de… c'est parti"), then the show's theme. One
   * sponsored episode carries no adverts and so no marker, which makes the theme — not
   * the marker — the only sound every episode opens with, and the jingle search
   * proposed it. In automatic mode it confirmed itself and cut the intro (1.10.1 too).
   */
  const theme = (n) => segment(5_000_000, frames(6), { variant: n % 8 });
  // Above every programme range (episodes 1–9 end below 2,000,000), so no intro shares
  // a frame with anything else.
  const intro = (n) => segment(3_000_000 + n * 10_000, frames(14 + n * 3));
  const marked = (n) =>
    stitch(
      advert(100 + n * 10, 30), MARKER(),
      intro(n), theme(n), programme(n, 240),
      MARKER(), advert(101 + n * 10, 30), MARKER(),
      programme(n, 240, 1),
      MARKER(), MARKER(), advert(102 + n * 10, 25),
    );
  const sponsored = (n) => stitch(intro(n), theme(n), programme(n, 500));
  const files = { 'e1.mp3': marked(1), 'e2.mp3': marked(2), 'e3.mp3': marked(3), 'e4.mp3': sponsored(4) };

  const jingle = (show) => server.adDetect.listAnchors(show.id)[0] ?? null;

  it('keeps the intro: the theme is offered as a jingle, not confirmed, and only the adverts are cut', async () => {
    const show = await makeShow('auto', files);
    await server.adPipeline.processShow(show.id);

    const anchor = jingle(show);
    assert.ok(anchor, 'no jingle was proposed: the scenario did not reproduce');
    assert.equal(anchor.confirmed_at, null, 'the theme was confirmed as the station jingle');
    assert.ok(
      !rows(show).some((r) => r.kind === SEGMENT_KINDS.JINGLE),
      'a jingle row is cutting',
    );
    for (const n of [1, 2, 3]) {
      assert.deepEqual(
        await served(show, `e${n}.mp3`),
        hashesOf(intro(n), theme(n), programme(n, 240), programme(n, 240, 1)),
        `e${n} is not exactly its intro, theme and programme`,
      );
    }
  });

  it('takes back a jingle it confirmed by itself before, and cuts the pre-roll instead', async () => {
    // An owner already on 1.10: the theme was confirmed automatically on an earlier pass.
    const show = await makeShow('auto', files);
    await server.adPipeline.processShow(show.id);
    // What 1.10 left behind: the anchor confirmed by itself, and its row cutting from
    // 0:00 to where the theme starts — written here as 1.10 wrote it, because this
    // version's detector would take it back the moment it ran.
    const anchor = jingle(show);
    server.db
      .prepare('UPDATE ad_anchors SET confirmed_at = ?, auto_confirmed = 1 WHERE id = ?')
      .run('2026-10-01T00:00:00.000Z', anchor.id);
    server.db
      .prepare(
        `INSERT INTO ad_segments (id, show_id, signature, source, kind, anchor_id, status, duration_ms, episode_count,
           occurrence_count, first_seen_at, created_at, updated_at)
         VALUES ('old-jingle', ?, ?, 'corpus', 'jingle', ?, 'approved', 50000, 3, 3, 'x', 'x', 'x')`,
      )
      .run(show.id, `anchor:${anchor.id}`, anchor.id);
    for (const hit of server.db.prepare('SELECT * FROM ad_anchor_hits WHERE anchor_id = ? AND heard = 1').all(anchor.id)) {
      const onset = hit.at_ms - anchor.lead_ms;
      if (onset < 2000) continue;
      server.db
        .prepare(
          `INSERT INTO ad_segment_occurrences (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
           VALUES ('old-jingle', ?, 0, ?, 0, ?)`,
        )
        .run(hit.episode_id, Math.floor(onset / FRAME_MS), onset);
      server.db.prepare(`UPDATE episodes SET trim_status = 'pending' WHERE id = ?`).run(hit.episode_id);
    }
    await server.trimmer.trimShow(show.id);
    assert.notDeepEqual(
      await served(show, 'e1.mp3'),
      hashesOf(intro(1), theme(1), programme(1, 240), programme(1, 240, 1)),
      'setup: the intro was not cut the way 1.10 cut it',
    );

    // A new episode arriving is what starts the next pass for real.
    await writeFile(join(showDir, 'e5.mp3'), marked(5));
    await server.scanner.scanAllNow('manual');
    await server.adPipeline.processShow(show.id);

    assert.equal(jingle(show).confirmed_at, null, 'the automatic confirmation stood');
    assert.ok(!rows(show).some((r) => r.kind === SEGMENT_KINDS.JINGLE), 'the jingle still cuts');
    assert.deepEqual(
      await served(show, 'e1.mp3'),
      hashesOf(intro(1), theme(1), programme(1, 240), programme(1, 240, 1)),
      'e1 is not exactly its intro, theme and programme',
    );
  });

  it('leaves a jingle the owner confirmed alone', async () => {
    const show = await makeShow('auto', files);
    await server.adPipeline.processShow(show.id);
    server.db
      .prepare(`UPDATE ad_anchors SET confirmed_at = ?, auto_confirmed = 0, origin = 'pointed_at' WHERE show_id = ?`)
      .run('2026-10-01T00:00:00.000Z', show.id);
    await server.adDetect.detectAnchors(show.id);
    assert.ok(jingle(show).confirmed_at, 'the owner’s decision was taken back');
    assert.ok(rows(show).some((r) => r.kind === SEGMENT_KINDS.JINGLE));
  });
});
