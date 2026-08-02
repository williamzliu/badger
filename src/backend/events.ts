import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BadgerEvent } from '../shared/types.js';

type Subscriber = (event: BadgerEvent) => void;

export class EventLog {
  private subscribers = new Map<string, Set<Subscriber>>();
  constructor(private readonly db: Database.Database) {}

  append(sessionId: string, type: string, publicMessage: string, privateData: Record<string, unknown> = {}): BadgerEvent {
    const event: BadgerEvent = { id: randomUUID(), sessionId, type, timestamp: new Date().toISOString(), publicMessage, privateData };
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(event.id, event.sessionId, event.type, event.timestamp, event.publicMessage, JSON.stringify(event.privateData));
    this.subscribers.get(sessionId)?.forEach((subscriber) => subscriber(event));
    return event;
  }

  list(sessionId: string): BadgerEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp').all(sessionId) as any[]).map((row) => ({
      id: row.id, sessionId: row.session_id, type: row.type, timestamp: row.timestamp,
      publicMessage: row.public_message, privateData: JSON.parse(row.private_data_json)
    }));
  }

  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    set.add(subscriber); this.subscribers.set(sessionId, set);
    return () => set.delete(subscriber);
  }
}
