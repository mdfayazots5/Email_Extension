import type { DatabaseSync } from "node:sqlite";

type Migration = {
  version: number;
  apply: (db: DatabaseSync) => void;
};

export const migrations: Migration[] = [
  {
    version: 1,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS queries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          country_code TEXT NOT NULL,
          label TEXT NOT NULL,
          query_text TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS query_filters (
          query_id INTEGER PRIMARY KEY REFERENCES queries(id) ON DELETE CASCADE,
          date_posted TEXT NOT NULL DEFAULT 'any',
          sort_by TEXT NOT NULL DEFAULT 'relevance',
          content_type TEXT NOT NULL DEFAULT 'all',
          from_member TEXT NOT NULL DEFAULT '',
          other_note TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          current_query_id INTEGER REFERENCES queries(id) ON DELETE SET NULL,
          continue_next INTEGER NOT NULL DEFAULT 1 CHECK (continue_next IN (0, 1)),
          progress_json TEXT NOT NULL DEFAULT '{}',
          profile_label TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS captures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          query_id INTEGER NOT NULL REFERENCES queries(id) ON DELETE RESTRICT,
          country_code TEXT NOT NULL,
          city TEXT NOT NULL DEFAULT '',
          post_url TEXT NOT NULL,
          post_date TEXT,
          captured_at TEXT NOT NULL,
          local_day TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS emails (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          normalized_email TEXT NOT NULL UNIQUE,
          original_email TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          first_seen_day TEXT NOT NULL,
          country_code TEXT NOT NULL,
          city TEXT NOT NULL DEFAULT '',
          post_url TEXT NOT NULL,
          post_date TEXT,
          source TEXT NOT NULL,
          review_status TEXT NOT NULL DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS email_occurrences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
          capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
          seen_at TEXT NOT NULL,
          local_day TEXT NOT NULL,
          is_duplicate INTEGER NOT NULL CHECK (is_duplicate IN (0, 1))
        );

        CREATE TABLE IF NOT EXISTS daily_sheets (
          day TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_emails_day_country
          ON emails(first_seen_day, country_code);
        CREATE INDEX IF NOT EXISTS idx_occurrences_day
          ON email_occurrences(local_day, is_duplicate);
      `);
    }
  },
  {
    version: 2,
    apply(db) {
      db.exec(`
        ALTER TABLE captures ADD COLUMN post_date_text TEXT NOT NULL DEFAULT '';
        ALTER TABLE captures ADD COLUMN author_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE captures ADD COLUMN post_text TEXT NOT NULL DEFAULT '';
        CREATE INDEX IF NOT EXISTS idx_captures_run_time ON captures(run_id, captured_at DESC);
      `);
    }
  },
  {
    version: 3,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_save_batches (
          batch_id TEXT PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 4,
    apply(db) {
      db.exec(`
        ALTER TABLE runs ADD COLUMN profile_id TEXT NOT NULL DEFAULT '';
        CREATE TABLE IF NOT EXISTS query_locks (
          query_id INTEGER PRIMARY KEY REFERENCES queries(id) ON DELETE CASCADE,
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL,
          profile_label TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_query_locks_expiry ON query_locks(expires_at);
        CREATE TABLE IF NOT EXISTS daily_run_stats (
          local_day TEXT NOT NULL,
          queries_completed INTEGER NOT NULL DEFAULT 0,
          posts_scanned INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(local_day)
        );
        CREATE TABLE IF NOT EXISTS run_query_usage (
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          query_id INTEGER NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
          last_posts_scanned INTEGER NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
          PRIMARY KEY(run_id, query_id)
        );
        CREATE INDEX IF NOT EXISTS idx_runs_status_profile ON runs(status, profile_id);
      `);
    }
  },
  {
    version: 5,
    apply(db) {
      db.exec(`
        ALTER TABLE email_occurrences ADD COLUMN original_email TEXT NOT NULL DEFAULT '';

        CREATE TABLE IF NOT EXISTS master_imports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          uploaded_at TEXT NOT NULL,
          rows_read INTEGER NOT NULL,
          valid_emails INTEGER NOT NULL,
          empty_cells INTEGER NOT NULL,
          duplicate_emails INTEGER NOT NULL,
          suspicious_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS master_emails (
          normalized_email TEXT PRIMARY KEY,
          original_text TEXT NOT NULL,
          row_number INTEGER NOT NULL,
          import_id INTEGER NOT NULL REFERENCES master_imports(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_master_emails_import ON master_emails(import_id);
        CREATE TABLE IF NOT EXISTS daily_comparisons (
          day TEXT PRIMARY KEY,
          collected_count INTEGER NOT NULL,
          in_master_count INTEGER NOT NULL,
          new_count INTEGER NOT NULL,
          recomputed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS daily_comparison_emails (
          day TEXT NOT NULL,
          normalized_email TEXT NOT NULL,
          original_email TEXT NOT NULL,
          country_code TEXT NOT NULL,
          city TEXT NOT NULL,
          post_url TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          in_master INTEGER NOT NULL CHECK (in_master IN (0, 1)),
          PRIMARY KEY(day, normalized_email)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_comparison_emails_day_country
          ON daily_comparison_emails(day, country_code, in_master);
      `);
    }
  },
  {
    version: 6,
    apply(db) {
      db.exec(`
        ALTER TABLE daily_comparison_emails
          ADD COLUMN is_new INTEGER NOT NULL DEFAULT 1 CHECK (is_new IN (0, 1));
        CREATE TABLE IF NOT EXISTS master_import_issues (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          import_id INTEGER NOT NULL REFERENCES master_imports(id) ON DELETE CASCADE,
          row_number INTEGER NOT NULL,
          reason TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 7,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS country_filters (
          country_code TEXT PRIMARY KEY,
          params TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          captured_at TEXT NOT NULL,
          profile_id TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 8,
    apply(db) {
      db.prepare(`
        UPDATE settings SET value = '250'
        WHERE key = 'max_scrolls_per_query'
          AND (value = '40' OR CAST(value AS INTEGER) > 250)
      `).run();
    }
  },
  {
    version: 9,
    apply(db) {
      db.prepare(`
          UPDATE settings SET value = '50'
          WHERE key = 'max_scrolls_per_query'
            AND (value IN ('40', '250') OR CAST(value AS INTEGER) > 50)
      `).run();
    }
  },
  {
    version: 10,
    apply(db) {
      db.prepare(`
        UPDATE settings SET value = '10000'
        WHERE key = 'max_posts_per_day' AND value = '1000'
      `).run();
    }
  },
  {
    version: 11,
    // Retired: previously rewrote or seeded one user's own search queries.
    // Kept as a no-op so migration numbers stay stable; new installs start with no queries.
    apply() {
      // Intentionally empty.
    }
  },
  {
    version: 12,
    // Retired: previously rewrote or seeded one user's own search queries.
    // Kept as a no-op so migration numbers stay stable; new installs start with no queries.
    apply() {
      // Intentionally empty.
    }
  },
  {
    version: 13,
    // Retired: previously rewrote or seeded one user's own search queries.
    // Kept as a no-op so migration numbers stay stable; new installs start with no queries.
    apply() {
      // Intentionally empty.
    }
  }
];
