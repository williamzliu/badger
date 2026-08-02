import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BadgerEvent } from '../shared/types.js';
import { humanizeSlotText } from '../shared/display.js';
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
    // publicMessage is rendered to people; machine slot tokens never are.
    const sanitized: BadgerEvent = { ...event, publicMessage: humanizeSlotText(event.publicMessage) };
    const result = this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      sanitized.id,
      sanitized.sessionId,
      sanitized.type,
      sanitized.timestamp,
      sanitized.publicMessage,
      JSON.stringify(sanitized.privateData),
    );
    if (result.changes === 0) return false;
    this.subscribers.get(sanitized.sessionId)?.forEach(subscriber=>subscriber(sanitized));
    return true;
  }

  list(sessionId:string):BadgerEvent[]{return (this.db.prepare('SELECT * FROM events WHERE session_id=? ORDER BY rowid').all(sessionId)as any[]).map(row=>({id:row.id,sessionId:row.session_id,type:row.type,timestamp:row.timestamp,publicMessage:row.public_message,privateData:JSON.parse(row.private_data_json)}));}
  subscribe(sessionId:string,subscriber:Subscriber){const set=this.subscribers.get(sessionId)??new Set<Subscriber>();set.add(subscriber);this.subscribers.set(sessionId,set);return()=>set.delete(subscriber);}
}
