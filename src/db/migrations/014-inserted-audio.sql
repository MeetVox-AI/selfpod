-- Audio a host inserts as it serves, found by its MP3 frames (spec §19.3).
--
-- A new kind of catalogue row, `inserted`: a stretch whose frames are byte for byte the
-- same in two or more episodes (a file the host spliced in), or a break between the slot
-- markers a host stitches around one. And a flag on a subscription saying its host is
-- known to insert, so every new episode of it is downloaded a second time.
--
-- Additive in effect, not in form, exactly as 009 was. `ad_segments.kind` is a CHECK
-- constraint and SQLite cannot widen one in place, so the catalogue and the two tables
-- that point at it are rebuilt with the same rows. The migration runner keeps foreign
-- keys ON inside its transaction, so the order matters: the replacements are built and
-- filled first, the old children are dropped while nothing references them, the old
-- parent only once it has no children left for an implicit DELETE to cascade into, and
-- the renames come last — renaming the parent is what rewrites the new children's
-- foreign keys to point at `ad_segments`.
--
-- An older image run against this schema reads an `inserted` row as one more row it
-- does not have a special case for, and cuts it like any other approved row. Rolling
-- back stays non-destructive, the property every migration since 007 preserves.

CREATE TABLE ad_segments_v3 (
  id             TEXT PRIMARY KEY,
  show_id        TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  signature      TEXT NOT NULL,
  -- 'transcript' is found by what was said. For a repeated read it is the hash of the
  -- words; for a boundary the owner taught it is `marker:{id}`.
  source         TEXT NOT NULL CHECK (source IN ('corpus', 'diff', 'transcript')),
  status         TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'approved', 'rejected')),
  auto_approved  INTEGER NOT NULL DEFAULT 0,
  hold_reason    TEXT,
  duration_ms    INTEGER NOT NULL,
  episode_count  INTEGER NOT NULL DEFAULT 0,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  exemplar_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  exemplar_start_ms   INTEGER,
  exemplar_end_ms     INTEGER,
  first_seen_at  TEXT NOT NULL,
  decided_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  -- What was said, for segments found by — or later matched to — the words.
  text           TEXT,
  raw_text       TEXT,
  cue_score      REAL,
  cues           TEXT,
  language       TEXT,

  -- What kind of thing the row is (011). `inserted` is new here: audio the host
  -- spliced in, found by its frames rather than by how it sounds.
  kind TEXT NOT NULL DEFAULT 'repeated_audio'
    CHECK (kind IN ('jingle', 'boundary_words', 'remembered_words', 'repeated_words',
                    'repeated_audio', 'diff', 'taught_range', 'inserted')),
  marker_id TEXT REFERENCES ad_markers(id) ON DELETE CASCADE,
  anchor_id TEXT REFERENCES ad_anchors(id) ON DELETE CASCADE,
  first_cut_at TEXT,

  UNIQUE(show_id, signature)
);

CREATE TABLE ad_segment_occurrences_v3 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id  TEXT NOT NULL REFERENCES ad_segments_v3(id) ON DELETE CASCADE,
  episode_id  TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  start_frame INTEGER NOT NULL,
  end_frame   INTEGER NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  UNIQUE(segment_id, episode_id, start_frame)
);

CREATE TABLE ad_cut_overrides_v3 (
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  segment_id  TEXT REFERENCES ad_segments_v3(id) ON DELETE SET NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL CHECK (end_ms > start_ms),
  created_at  TEXT NOT NULL
);

INSERT INTO ad_segments_v3
  (id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
   episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
   first_seen_at, decided_at, created_at, updated_at, text, raw_text, cue_score, cues, language,
   kind, marker_id, anchor_id, first_cut_at)
SELECT
   id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
   episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
   first_seen_at, decided_at, created_at, updated_at, text, raw_text, cue_score, cues, language,
   kind, marker_id, anchor_id, first_cut_at
FROM ad_segments;

INSERT INTO ad_segment_occurrences_v3
  (id, segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
SELECT id, segment_id, episode_id, start_frame, end_frame, start_ms, end_ms
FROM ad_segment_occurrences;

INSERT INTO ad_cut_overrides_v3 (id, episode_id, segment_id, start_ms, end_ms, created_at)
SELECT id, episode_id, segment_id, start_ms, end_ms, created_at
FROM ad_cut_overrides;

DROP TABLE ad_cut_overrides;
DROP TABLE ad_segment_occurrences;
DROP TABLE ad_segments;

ALTER TABLE ad_segments_v3 RENAME TO ad_segments;
ALTER TABLE ad_segment_occurrences_v3 RENAME TO ad_segment_occurrences;
ALTER TABLE ad_cut_overrides_v3 RENAME TO ad_cut_overrides;

CREATE INDEX idx_ad_segments_show ON ad_segments(show_id, status);
CREATE INDEX idx_ad_segments_kind ON ad_segments(show_id, kind);
CREATE INDEX idx_ad_segments_marker ON ad_segments(marker_id);
CREATE INDEX idx_ad_segments_anchor ON ad_segments(anchor_id);
CREATE INDEX idx_ad_occurrences_episode ON ad_segment_occurrences(episode_id);
CREATE INDEX idx_ad_cut_overrides_episode ON ad_cut_overrides(episode_id);
CREATE INDEX idx_ad_cut_overrides_segment ON ad_cut_overrides(segment_id);

-- The host of this feed has been seen inserting audio — set by SelfPod the first time
-- it finds some, or by the owner — so every new episode is downloaded a second time a
-- day later to learn the adverts that rotate (spec §19.3). Never a disguise: the same
-- address and the same user agent as the first download.
ALTER TABLE feed_subscriptions ADD COLUMN inserts_audio INTEGER NOT NULL DEFAULT 0;
