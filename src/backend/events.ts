import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BadgerEvent } from '../shared/types.js';
type Subscriber = (event: BadgerEvent) => void;
export type PublicEvent = Omit<BadgerEvent, 'privateData'>;

export function toPublicEvent(event: BadgerEvent): PublicEvent {
  const { privateData: _privateData, ...publicEvent } = event;
  return publicEvent;
}

export class EventLog {
  private subscribers = new Map<string, Set<Subscriber>>();
  constructor(private readonly db: Database.Database) {}

  append(sessionId:string,type:string,publicMessage:string,privateData:Record<string,unknown>={}):BadgerEvent {
    const participantId = typeof privateData.participantId === 'string' ? privateData.participantId : undefined;
    const event: BadgerEvent = {
      id: randomUUID(),
      sessionId,
      ...(participantId ? { participantId } : {}),
      type,
      timestamp: new Date().toISOString(),
      publicMessage,
      privateData,
    };
    this.record(event);
    return event;
  }

  record(event: BadgerEvent): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      event.id,
      event.sessionId,
      event.type,
      event.timestamp,
      event.publicMessage,
      JSON.stringify(event.privateData),
    );
    if (result.changes === 0) return false;
    this.subscribers.get(event.sessionId)?.forEach(subscriber=>subscriber(event));
    return true;
  }

  list(sessionId:string):BadgerEvent[]{return (this.db.prepare('SELECT * FROM events WHERE session_id=? ORDER BY timestamp').all(sessionId)as any[]).map(row=>({id:row.id,sessionId:row.session_id,type:row.type,timestamp:row.timestamp,publicMessage:row.public_message,privateData:JSON.parse(row.private_data_json)}));}
  subscribe(sessionId:string,subscriber:Subscriber){const set=this.subscribers.get(sessionId)??new Set<Subscriber>();set.add(subscriber);this.subscribers.set(sessionId,set);return()=>set.delete(subscriber);}
}
