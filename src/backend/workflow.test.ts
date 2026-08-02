import assert from 'node:assert/strict';
import { openDatabase } from './db.js';
import { EventLog } from './events.js';
import { instantInboundDecision } from './communications.js';
import { SessionStore } from './sessions.js';
import { validateDecision } from './sail.js';
import { BadgerWorkflow, matchesCandidateConstraint, matchesSlot } from './state-machine.js';

const db=openDatabase(':memory:'), store=new SessionStore(db), events=new EventLog(db), workflow=new BadgerWorkflow(store,events);
assert.equal(matchesSlot('sunday_anytime','sunday_evening'),true);
assert.equal(matchesSlot('sunday_anytime','saturday_evening'),false);
assert.equal(matchesSlot('every_evening_6_to_10','sunday_evening'),true);
assert.equal(matchesSlot('every_evening_6_to_10','sunday_afternoon'),false);
assert.equal(matchesCandidateConstraint('outside_san_francisco',{id:'sf',theater:'Balboa',time:'Sunday 3 PM',slot:'sunday_afternoon',format:'Digital',price:0,location:'San Francisco, CA'}),false);
assert.equal(matchesCandidateConstraint('outside_san_francisco',{id:'sea',theater:'SIFF',time:'Sunday 7 PM',slot:'sunday_evening',format:'70mm',price:0,location:'Seattle, WA'}),true);
assert.equal(matchesCandidateConstraint('outside_every_evening_6_to_10',{id:'sun-7',theater:'Balboa',time:'Sunday 7 PM',slot:'sunday_evening',format:'Digital',price:0,location:'San Francisco, CA'}),false);
assert.equal(matchesCandidateConstraint('outside_every_evening_6_to_10',{id:'sun-3',theater:'Balboa',time:'Sunday 3 PM',slot:'sunday_afternoon',format:'Digital',price:0,location:'San Francisco, CA'}),true);
const created=store.create({hostName:'Host',goal:'Demo'});
store.addParticipant(created,{name:'Alex',phone:'+15550000001'});
store.addParticipant(created,{name:'Priya',phone:'+15550000002'});
const session=store.get(created.id)!;
workflow.start(session);
for(const p of session.participants) workflow.recordPreferences(session,p,{availability:['friday_after_8','saturday_afternoon'],hardVetoes:[],preferences:['imax'],flexibility:.7,summary:'Friday or Saturday works'});
assert.equal(session.status,'PROPOSING');
assert.ok(session.selectedCandidateId);
assert.equal(events.list(session.id).at(-1)?.type,'plan.proposed');
const rejectedCandidateId=session.selectedCandidateId;
workflow.rejectCandidate(session,session.participants[0]!);
assert.equal(session.status,'PROPOSING');
assert.notEqual(session.selectedCandidateId,rejectedCandidateId);
assert.equal(session.candidates.find((candidate)=>candidate.id===session.selectedCandidateId)?.slot,'saturday_afternoon');
assert.equal(events.list(session.id).some((event)=>event.type==='session.cancelled'),false);
assert.equal(events.list(session.id).some((event)=>event.type==='proposal.rejected'),true);

const conflicted=store.create({hostName:'Host',goal:'Conflict demo'});
store.addParticipant(conflicted,{name:'Flexible',phone:'+15550000003'});
store.addParticipant(conflicted,{name:'Available',phone:'+15550000004'});
const conflictSession=store.get(conflicted.id)!;
workflow.start(conflictSession);
workflow.recordPreferences(conflictSession,conflictSession.participants[0]!,{availability:['saturday_afternoon'],hardVetoes:[],preferences:['imax'],flexibility:.9,summary:'Could flex'});
workflow.recordPreferences(conflictSession,conflictSession.participants[1]!,{availability:['friday_after_8'],hardVetoes:[],preferences:['imax'],flexibility:.1,summary:'Friday only'});
assert.equal(conflictSession.status,'RESOLVING');
const target=conflictSession.participants.find((participant)=>participant.status==='NEEDS_FOLLOWUP');
assert.equal(target?.name,'Flexible');
const askCount=events.list(conflictSession.id).filter((event)=>event.type==='flexibility.requested').length;
workflow.recordPreferences(conflictSession,target!,target!.preferences!);
assert.equal(events.list(conflictSession.id).filter((event)=>event.type==='flexibility.requested').length,askCount);
const saturday=conflictSession.candidates.find((candidate)=>candidate.slot==='saturday_afternoon')!;
const available=conflictSession.participants.find((participant)=>participant.name==='Available')!;
const sailDecision=validateDecision(conflictSession,{
  action:'REQUEST_FLEXIBILITY',candidateId:saturday.id,participantId:available.id,
  message:'Could Saturday afternoon work instead?',reason:'This preserves the stronger option for the group',
  channel:'CALL',delaySeconds:3,
});
workflow.applyPlannerDecision(conflictSession,sailDecision);
const revisedTarget=conflictSession.participants.find((participant)=>participant.status==='NEEDS_FOLLOWUP');
assert.equal(revisedTarget?.name,'Available');
assert.equal(conflictSession.selectedCandidateId,saturday.id);
assert.equal(events.list(conflictSession.id).some((event)=>event.type==='conflict.strategy_selected'),true);
workflow.markCalling(conflictSession,revisedTarget!);
workflow.markInCall(conflictSession,revisedTarget!);
workflow.markCallFinished(conflictSession,revisedTarget!,true);
assert.equal(revisedTarget?.status,'NEEDS_FOLLOWUP');
workflow.acceptFlexibility(conflictSession,revisedTarget!);
assert.equal(conflictSession.status,'PROPOSING');

const exhausted=store.create({hostName:'Host',goal:'Sunday plan'});
store.addParticipant(exhausted,{name:'Morgan',phone:'+15550000005'});
store.addParticipant(exhausted,{name:'Riley',phone:'+15550000006'});
const exhaustedSession=store.get(exhausted.id)!;
workflow.start(exhaustedSession);
for(const participant of exhaustedSession.participants) {
  workflow.recordPreferences(exhaustedSession,participant,{
    availability:[],hardVetoes:['any_time'],preferences:[],flexibility:.5,summary:'Needs another window',
  });
}
assert.equal(exhaustedSession.status,'RESOLVING');
assert.equal(exhaustedSession.selectedCandidateId,undefined);
assert.equal(exhaustedSession.participants.filter((participant)=>participant.status==='NEEDS_FOLLOWUP').length,1);
assert.equal(events.list(exhaustedSession.id).some((event)=>event.type==='session.cancelled'),false);

const laterDraft=store.create({hostName:'Kaustubh',goal:'See the Odyssey this weekend'});
store.addParticipant(laterDraft,{name:'Kaustubh',phone:'+15550000007'});
store.addParticipant(laterDraft,{name:'Eric',phone:'+15550000008'});
store.replaceCandidates(laterDraft.id,[
  {id:'balboa-3',theater:'The Balboa',time:'2026-08-02 3:00 PM',slot:'sunday_afternoon',format:'Digital',price:0,location:'San Francisco, CA'},
  {id:'balboa-7',theater:'The Balboa',time:'2026-08-02 7:00 PM',slot:'sunday_evening',format:'Digital',price:0,location:'San Francisco, CA'},
]);
const laterSession=store.get(laterDraft.id)!;
workflow.start(laterSession);
for(const participant of laterSession.participants) {
  workflow.recordPreferences(laterSession,participant,{
    availability:['anytime_this_weekend'],hardVetoes:[],preferences:[],flexibility:1,summary:'Any time this weekend',
  });
}
assert.equal(laterSession.selectedCandidateId,'balboa-3');
const eric=laterSession.participants.find((participant)=>participant.name==='Eric')!;
workflow.confirm(laterSession,eric);
const kaustubh=laterSession.participants.find((participant)=>participant.name==='Kaustubh')!;
const laterDecision=instantInboundDecision(laterSession,kaustubh,'Hmm not 3pm, can we do later in the day?')!;
assert.equal(laterDecision.action,'REJECT_ACTIVE_OPTION');
workflow.rejectCandidate(laterSession,kaustubh,laterDecision.preferences);
assert.equal(laterSession.selectedCandidateId,'balboa-7');
assert.equal(laterSession.participants.every((participant)=>participant.status==='PROPOSED'),true);
workflow.confirm(laterSession,kaustubh);
assert.equal(laterSession.status,'PROPOSING');
workflow.confirm(laterSession,eric);
assert.equal(laterSession.status,'COMMITTED');
assert.equal(laterSession.selectedCandidateId,'balboa-7');
console.info('workflow test passed');
