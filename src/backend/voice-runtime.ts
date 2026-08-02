import { CartesiaClient, requestBadgerCall } from '../voice/cartesia.js';
import { CartesiaWebhookProcessor } from '../voice/webhooks.js';
import { SpectrumMessagingClient, classifyInboundMessage, MESSAGE_COPY, processSpectrumInbound, sendBadgerMessage } from '../voice/spectrum.js';
import { parseParticipantPreferences, type BadgerEvent, type EventSink, type Session } from '../shared/types.js';
import { EventLog } from './events.js';
import { SessionStore } from './sessions.js';
import { BadgerWorkflow } from './state-machine.js';

export function createVoiceRuntime(sessions:SessionStore,events:EventLog,workflow:BadgerWorkflow){
  const emit:EventSink=async(event:BadgerEvent)=>{if(event.type==='preferences.received'){const session=sessions.get(event.sessionId),participant=session?.participants.find(p=>p.id===event.participantId);if(session&&participant){const raw=event.privateData.preferences;workflow.recordPreferences(session,participant,parseParticipantPreferences({...raw as object,participantId:participant.id}));return;}}events.append(event.sessionId,event.type,event.publicMessage,event.privateData);};
  const cartesia=process.env.CARTESIA_API_KEY&&process.env.CARTESIA_AGENT_ID&&process.env.CARTESIA_FROM_NUMBER_ID?new CartesiaClient({apiKey:process.env.CARTESIA_API_KEY,agentId:process.env.CARTESIA_AGENT_ID,fromNumberId:process.env.CARTESIA_FROM_NUMBER_ID}):undefined;
  const spectrum=process.env.SPECTRUM_PROJECT_ID&&process.env.SPECTRUM_PROJECT_SECRET?new SpectrumMessagingClient({projectId:process.env.SPECTRUM_PROJECT_ID,projectSecret:process.env.SPECTRUM_PROJECT_SECRET}):undefined;
  const processor=process.env.CARTESIA_WEBHOOK_SECRET?new CartesiaWebhookProcessor({webhookSecret:process.env.CARTESIA_WEBHOOK_SECRET,emit}):undefined;
  if(spectrum) void spectrum.listenForReplies({resolveContext:phone=>{const found=sessions.findActiveByPhone(phone);return found&&{sessionId:found.session.id,participantId:found.participant.id,participantName:found.participant.name};},emit:async event=>{await processInbound(event);}}).catch(error=>console.error('Spectrum listener stopped',error));
  async function processInbound(event:BadgerEvent){await emit(event);const intent=typeof event.privateData.intent==='string'?event.privateData.intent:'freeform',session=sessions.get(event.sessionId),participant=session?.participants.find(p=>p.id===event.participantId);if(!session||!participant)return;if(intent==='confirm')workflow.confirm(session,participant);if(intent==='decline'||intent==='opt_out')workflow.decline(session,participant);}
  async function contact(session:Session){if(!cartesia||!spectrum)return;for(const p of session.participants){if(p.status==='DECLINED')continue;await sendBadgerMessage(spectrum,{to:p.phone,body:MESSAGE_COPY.opening(session.hostName,session.goal),sessionId:session.id,participantId:p.id,idempotencyKey:`${session.id}:${p.id}:opening`},emit);await requestBadgerCall(cartesia,{to:p.phone,metadata:{sessionId:session.id,participantId:p.id,participantName:p.name,hostName:session.hostName,goal:session.goal},idempotencyKey:`${session.id}:${p.id}:initial-call`},emit);}}
  return {enabled:Boolean(cartesia&&spectrum),contact,processCartesia:processor?processor.process.bind(processor):undefined,stop:()=>spectrum?.stop()};
}
