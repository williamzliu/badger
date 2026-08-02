import assert from 'node:assert/strict';
import { openDatabase } from './db.js';
import { EventLog } from './events.js';
import { SessionStore } from './sessions.js';
import { BadgerWorkflow } from './state-machine.js';

const db=openDatabase(':memory:'), store=new SessionStore(db), events=new EventLog(db), workflow=new BadgerWorkflow(store,events);
const created=store.create({hostName:'Host',goal:'Demo'});
store.addParticipant(created,{name:'Alex',phone:'+15550000001'});
store.addParticipant(created,{name:'Priya',phone:'+15550000002'});
const session=store.get(created.id)!;
workflow.start(session);
for(const p of session.participants) workflow.recordPreferences(session,p,{availability:['friday_after_8'],hardVetoes:[],preferences:['imax'],flexibility:.7,summary:'Friday works'});
assert.equal(session.status,'PROPOSING');
assert.ok(session.selectedCandidateId);
assert.equal(events.list(session.id).at(-1)?.type,'plan.proposed');
console.info('workflow test passed');
