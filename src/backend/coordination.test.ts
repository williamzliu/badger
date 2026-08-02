import assert from 'node:assert/strict';
import { createServer } from './server.js';
import { toPublicEvent } from './events.js';

const {app,events}=createServer();
const make=async(name:string)=>{const s=(await app.inject({method:'POST',url:'/sessions',payload:{hostName:'Host',goal:'Demo'}})).json();for(const p of ['Alex','Priya'])await app.inject({method:'POST',url:`/sessions/${s.id}/participants`,payload:{name:p,phone:'+15550000001'}});await app.inject({method:'POST',url:`/sessions/${s.id}/start`});return s.id;};
const id=await make('happy');let state=(await app.inject({method:'GET',url:`/sessions/${id}`})).json();
for(const p of state.participants){const r=await app.inject({method:'POST',url:'/internal/preferences',payload:{sessionId:id,participantId:p.id,availability:['friday_after_8'],hardVetoes:[],preferences:['imax'],flexibility:.5,summary:'Friday works'}});assert.equal(r.statusCode,200);}
state=(await app.inject({method:'GET',url:`/sessions/${id}`})).json();assert.equal(state.status,'PROPOSING');
assert.equal((await app.inject({method:'POST',url:`/sessions/${id}/participants/${state.participants[0].id}/confirm`})).statusCode,200);
state=(await app.inject({method:'POST',url:`/sessions/${id}/participants/${state.participants[1].id}/confirm`})).json();assert.equal(state.status,'COMMITTED');
const invalid=await app.inject({method:'POST',url:'/internal/preferences',payload:{sessionId:id,participantId:'none',availability:[]}});assert.equal(invalid.statusCode,404);
const secret=toPublicEvent(events.list(id)[0]);assert.equal('privateData' in secret,false);
const declineId=await make('decline');state=(await app.inject({method:'GET',url:`/sessions/${declineId}`})).json();state=(await app.inject({method:'POST',url:`/sessions/${declineId}/participants/${state.participants[0].id}/decline`})).json();assert.equal(state.status,'CANCELLED');
await app.close();console.info('coordination test passed');
