import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(filename: string) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      host_name TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      selected_candidate_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      required INTEGER NOT NULL,
      status TEXT NOT NULL,
      preferences_json TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    CREATE INDEX IF NOT EXISTS participants_phone_idx ON participants(phone);
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      theater TEXT NOT NULL,
      time TEXT NOT NULL,
      slot TEXT NOT NULL,
      format TEXT NOT NULL,
      price REAL NOT NULL,
      location TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      public_message TEXT NOT NULL,
      private_data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_receipts (
      provider TEXT NOT NULL,
      webhook_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY(provider, webhook_id)
    );
    CREATE TABLE IF NOT EXISTS call_contexts (
      call_id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}
