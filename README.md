TechLife VoiceBridge Enterprise
Multi-Tenant AI Call Center + VoiceBot Platform
v2.0.0  |  Rasa  Chatwoot  Dialogflow  Watson  Lex  GPT-4o  Claude  Custom



1. System Overview
TechLife VoiceBridge Enterprise is a production-grade multi-tenant AI call center platform with a full VoiceBot engine. Each tenant can have multiple bot agents handling inbound and outbound calls autonomously -- transcribing speech, understanding intent, responding with neural TTS, and escalating to human agents when needed. Superadmin controls which bot engines are available per tenant via feature flags.

1.1 Server Ports
Port	Protocol	Service
4000	TCP	REST API (all endpoints + Swagger docs)
8765	TCP/WS	WebSocket AI + VoiceBot bridge (PBX audio)
5000	TCP	Inbound webhook server (Asterisk/FreeSWITCH/Kamailio)
3000	TCP	Dashboard + Socket.IO real-time events
8776	TCP	FreeSWITCH ESL listener (auto-connect)
5060	UDP/TCP	SIP (Asterisk or Kamailio)
5080	UDP/TCP	FreeSWITCH SIP

1.2 Complete File Structure (37 source files)
File	Purpose
src/index.js	Application entry point -- starts all 4 servers
src/core/logger.js	Winston logger with daily rotation
src/db/couch.js	CouchDB layer -- global + per-tenant isolated databases + features field
src/api/middleware/auth.js	JWT auth -- superadmin / admin / supervisor / agent roles
src/api/server.js	Complete REST API -- all endpoints, bot router mounted
src/ai/client.js	Unified AI client -- Claude, GPT-4o, DeepSeek, IBM, DeepL, Azure, ElevenLabs
src/billing/engine.js	Per-query cost metering -- ASR, TTS, LLM, Translation with markup %
src/reports/engine.js	CDR, ACD, CSAT, Queue, Agent, Billing reports + CSV export
src/reports/scheduler.js	Cron scheduler -- daily CDR, weekly CSAT, monthly billing
src/tenant/manager.js	User management, PBX config, webhooks, CRM per tenant
src/bot/engine.js	VoiceBot engine -- routes to all 9 bot providers
src/bot/api.js	Bot REST API -- agents, campaigns, analytics, feature flags
src/bot/outbound.js	Outbound dialler -- AMD, voicemail, retry logic, campaign stats
src/realtime/ws-bridge.js	WebSocket bridge -- ASR + Bot engine + TTS pipeline
src/realtime/dashboard.js	Socket.IO dashboard -- live call events broadcast
src/webhook/server.js	Inbound webhooks -- Asterisk ARI, FreeSWITCH ESL, Kamailio MI
src/webhook/outbound.js	Outbound events -- CRM push (Salesforce, HubSpot, Zoho, Zendesk)
public/index.html	Full enterprise dashboard -- login, tenants, live calls, bots, reports
scripts/setup-db.js	CouchDB init + superadmin + demo tenant + demo users
scripts/setup-pbx.js	PBX config deployer -- Asterisk, FreeSWITCH, Kamailio, Nginx
scripts/seed.js	Demo data seeder -- orders, CDR records, CSAT
scripts/whisper_server.py	Whisper ASR subprocess -- streams PCM, returns JSON transcript
configs/asterisk/	pjsip.conf, extensions.conf, ari.conf, rtp.conf, techlife_agi.py
configs/freeswitch/	00_techlife_dialplan.xml, event_socket.conf.xml
configs/kamailio/	kamailio.cfg (load balancer), dispatcher.list
configs/nginx/	techlife.conf (reverse proxy)
configs/systemd/	techlife-voicebridge.service
install.sh	One-click Debian 12/13 installer with wizard

2. VoiceBot Engine
The VoiceBot engine (src/bot/engine.js) is a unified dispatcher that routes each caller utterance to the configured bot provider for the tenant. It maintains per-call session state, handles escalation rules, and builds warm transfer briefs for human agents.

2.1 Supported Bot Engines
Engine	Protocol	Self-hosted	Best for
Rasa 3.x	REST + webhook	Yes (Docker)	Domain-specific NLU, custom intents, entities, stories
Chatwoot	API v2	Yes or Cloud	Live chat + bot + CRM, team inbox, agent handoff built-in
Dialogflow CX	REST + gRPC	No (GCP)	Enterprise NLP, visual flow builder, Google ecosystem
IBM Watson Assistant	REST v2	No (IBM Cloud)	Regulated industries, on-prem option available
Amazon Lex v2	AWS SDK	No (AWS)	AWS ecosystem, Lambda function integrations
Microsoft Bot Framework	REST	Yes or Azure	.NET ecosystem, Teams / Cortana integration
GPT-4o (function calling)	OpenAI API	No	Flexible LLM with order lookup, booking, tool use
Claude AI (native)	Anthropic API	No	High quality, multilingual, always-available fallback
Custom HTTP bot	REST/webhook	Yes	Any REST endpoint -- n8n, Zapier, proprietary systems

2.2 VoiceBot Call Flow
Step	Component	Approx latency
1. SIP call arrives	Asterisk / FreeSWITCH / Kamailio	< 1 ms
2. Raw PCM audio stream	WebSocket bridge (ws://host:8765)	--
3. Speech-to-Text	Whisper (local) or Deepgram/Azure/Google/IBM	~90 ms
4. Language detection	Heuristic rules + LibreTranslate	~8 ms
5. Translate to English	DeepL / Azure / Google / LibreTranslate	~140 ms
6. Bot NLU + response	Rasa / Chatwoot / Claude / GPT-4o / Custom	~50-200 ms
7. Neural TTS	Azure Neural / ElevenLabs / Google WaveNet	~35 ms
8. PCM audio to caller	WebSocket binary frame back to PBX	< 1 ms
9. Escalate if needed	Warm transfer with context brief	< 1 ms

2.3 Escalation Triggers
Trigger	When it fires
intent_transfer	Caller says "agent", "human", "manager", "supervisor", "real person"
low_confidence	NLU confidence below configured threshold (default 0.65)
max_turns_reached	Turn count exceeds max_turns (default 8 turns)
frustration_detected	Anger / frustration keywords detected in recent history
caller_requested_human	Any phrase indicating caller wants a person
bot_requested_transfer	Bot engine explicitly returns { escalate: true }
On escalation: VoiceBot sends { type:"escalate", brief:"..." } on the WebSocket. Brief contains last 4 turns + context for the human agent to read before accepting the call.

3. VoiceBot API Reference
3.1 Bot Configuration
Method	Endpoint	Auth	Description
GET	/api/tenant/:id/bot/config	tenant access	Get bot config (secrets redacted)
PUT	/api/tenant/:id/bot/config	admin	Save bot config for chosen engine
POST	/api/tenant/:id/bot/test	admin	Test bot with sample utterance
POST	/api/tenant/:id/bot/chat	tenant access	Send text message to bot

3.2 Bot Agents CRUD
Method	Endpoint	Description
GET	/api/tenant/:id/bot/agents	List all configured bot agents
POST	/api/tenant/:id/bot/agents	Create bot agent (name, type, extension, direction)
PUT	/api/tenant/:id/bot/agents/:agentId	Update bot agent settings
DELETE	/api/tenant/:id/bot/agents/:agentId	Disable bot agent

3.3 Outbound Campaigns
Method	Endpoint	Description
GET	/api/tenant/:id/bot/campaigns	List all campaigns with stats
POST	/api/tenant/:id/bot/campaigns	Create campaign (contacts, script, bot_type, schedule)
GET	/api/tenant/:id/bot/campaigns/:id	Get campaign + live stats
POST	/api/tenant/:id/bot/campaigns/:id/start	Start dialler
POST	/api/tenant/:id/bot/campaigns/:id/pause	Pause dialler
POST	/api/tenant/:id/bot/campaigns/:id/stop	Stop campaign
POST	/api/tenant/:id/bot/campaigns/:id/contacts	Add contacts (JSON array)
GET	/api/tenant/:id/bot/analytics	Resolution rate, escalations, intent breakdown

3.4 Superadmin Feature Flags
Superadmin enables specific bot engines per tenant. Only enabled engines appear in the tenant admin config.
PUT /api/tenant/:tenantId/bot/features  (superadmin only)
{ "tenant_id": "demo_corp",
  "features": {
    "bot_enabled":    true,
    "inbound_bot":    true,
    "outbound_bot":   true,
    "bot_rasa":       true,
    "bot_chatwoot":   true,
    "bot_dialogflow": false,
    "bot_watson":     false,
    "bot_lex":        false,
    "bot_gpt4o":      true,
    "bot_claude":     true,   // always on
    "bot_custom":     true
  }
}

4. Bot Configuration Payloads
4.1 Rasa
PUT /api/tenant/:id/bot/config
{ "bot_type": "rasa",
  "enabled": true,
  "rasa_url": "http://127.0.0.1:5005",
  "token": "optional_rasa_token",
  "model_name": "voicebridge_v2",
  "escalation": { "min_confidence": 0.65, "max_turns": 8 }
}

4.2 Chatwoot
{ "bot_type": "chatwoot",
  "chatwoot_url": "https://app.chatwoot.com",
  "chatwoot_token": "your_api_access_token",
  "chatwoot_account_id": 1,
  "chatwoot_inbox_id": 3,
  "chatwoot_bot_agent_id": 42
}

4.3 Dialogflow CX
{ "bot_type": "dialogflow",
  "gcp_key_file": "/etc/gcp/service-account.json",
  "gcp_project_id": "my-project-123",
  "dialogflow_agent_id": "abc-def-ghi",
  "dialogflow_location": "us-central1"
}

4.4 Custom HTTP bot
Your endpoint receives this payload on every utterance:
POST https://your-bot.company.com/webhook
{ "tenant_id": "demo_corp", "call_id": "c-2847",
  "transcript": "I need order 88421 status",
  "translated": "I need order 88421 status",
  "caller_lang": "es", "caller_num": "+34612345678",
  "session_id": "sess_abc123", "turn": 3,
  "history": [...], "context": {...} }

Your bot must return:
{ "response": "Your order #88421 ships via DHL, arriving tomorrow.",
  "intent":   "order_status",
  "confidence": 0.97,
  "escalate": false
}

5. Outbound Campaign Format
5.1 Create campaign
POST /api/tenant/:id/bot/campaigns
{ "name":     "Appointment reminders -- June",
  "bot_type": "rasa",
  "caller_id": "+18005550100",
  "schedule_at": "2025-06-01T09:00:00Z",
  "max_retries": 3,
  "retry_delay_min": 60,
  "amd_enabled": true,
  "voicemail_msg": "Hello, please call us back at +18005550100.",
  "script": { "greeting": "Hello {name}, this is VoiceBot from {company}." },
  "contacts": [
    { "name": "John Smith",  "phone": "+12025551234", "date": "June 5" },
    { "name": "Priya Singh", "phone": "+919812345678","date": "June 6" }
  ]
}

5.2 Script interpolation variables
Variable	Source	Example output
{name}	contacts[].name	Hello John
{company}	Tenant name	This is Demo Corp
{phone}	Campaign caller_id	Call us at +18005550100
{date}	contacts[].date	Your appointment on June 5
{time}	contacts[].time	at 10:00 AM
{order_id}	contacts[].order_id	order #88421

6. Multi-Tenant Model
6.1 CouchDB database layout
Database	Type	Contents
vb_tenants	Global	All tenant documents with settings + feature flags
vb_superadmins	Global	Superadmin user accounts
vb_audit	Global	All platform audit events
vb_{tenantId}_calls	Per-tenant	Active and ended call records
vb_{tenantId}_transcripts	Per-tenant	All utterances + bot turns + agent replies
vb_{tenantId}_billing	Per-tenant	Per-query cost records + monthly summaries
vb_{tenantId}_cdr	Per-tenant	Call detail records (CDR)
vb_{tenantId}_csat	Per-tenant	Post-call CSAT survey responses
vb_{tenantId}_agents	Per-tenant	Human agent user accounts
vb_{tenantId}_config	Per-tenant	PBX config, pricing, bot config, campaigns, bot agents
vb_{tenantId}_orders	Per-tenant	Customer orders (used by GPT-4o tool calling)
vb_{tenantId}_webhooks	Per-tenant	Inbound webhook event log

6.2 User roles
Role	Scope	Permissions
superadmin	Global	Create tenants, set feature flags, view global stats, any config
admin	Own tenant	Manage users, pricing, PBX, bot config, webhooks, CRM, all reports
supervisor	Own tenant	View all reports, manage agents, view billing, bot analytics
agent	Own tenant	Handle live calls, view own stats, use bot dashboard

7. All REST API Endpoints
7.1 Superadmin
Method	Endpoint	Description
POST	/api/superadmin/login	Login, get JWT
GET	/api/superadmin/tenants	List all tenants
POST	/api/superadmin/tenants	Create tenant (sets feature flags)
PUT	/api/superadmin/tenants/:id	Update tenant plan, status, settings
DELETE	/api/superadmin/tenants/:id	Suspend tenant
GET	/api/superadmin/stats	Platform-wide statistics
PUT	/api/tenant/:id/bot/features	Set bot feature flags for tenant

7.2 Tenant auth + users
Method	Endpoint	Description
POST	/api/tenant/:id/login	Tenant user login, returns JWT + user info
GET	/api/tenant/:id/users	List users/agents
POST	/api/tenant/:id/users	Create user (role: agent/supervisor/admin)
PUT	/api/tenant/:id/users/:uid/status	Set agent status online/offline/busy
DELETE	/api/tenant/:id/users/:uid	Disable user

7.3 Calls + AI
Method	Endpoint	Description
GET	/api/tenant/:id/calls	List active calls + live WS sessions
GET	/api/tenant/:id/calls/:callId	Call detail + all transcripts
POST	/api/tenant/:id/calls/incoming	Notify of incoming call from PBX
POST	/api/tenant/:id/calls/:callId/hangup	End call (saves CDR)
POST	/api/tenant/:id/csat	Submit post-call CSAT rating
POST	/api/tenant/:id/ai/chat	Chat with bot (uses tenant bot config)
POST	/api/tenant/:id/ai/translate	Translate text
POST	/api/tenant/:id/ai/detect	Detect language of text

7.4 Config + reports
Method	Endpoint	Description
GET/PUT	/api/tenant/:id/pricing	Vendor pricing rates + markup %
GET/PUT	/api/tenant/:id/pbx	PBX connection config
GET/POST/DELETE	/api/tenant/:id/webhooks	Outbound webhooks
POST	/api/tenant/:id/webhooks/test	Fire test payload to webhook URL
PUT	/api/tenant/:id/crm	CRM integration (Salesforce/HubSpot/Zoho/Zendesk)
GET	/api/tenant/:id/reports/dashboard	Today + month summary
GET	/api/tenant/:id/reports/cdr	CDR (add ?format=csv for download)
GET	/api/tenant/:id/reports/acd	ACD: answer rate, SLA, AHT
GET	/api/tenant/:id/reports/csat	CSAT: avg rating, NPS
GET	/api/tenant/:id/reports/queue	Queue: wait times per queue
GET	/api/tenant/:id/reports/agents	Agent performance report
GET	/api/tenant/:id/reports/billing	Monthly billing by vendor
POST	/api/tenant/:id/reports/deliver	Push report via email or webhook

8. Quick Start Guide
8.1 Install on Debian 12
unzip techlife-voicebridge-enterprise-v2.0.0.zip
cd vbfinal
sudo bash install.sh

Installer wizard prompts for: CouchDB credentials, superadmin email/password, API keys (Anthropic, DeepL, Azure), PBX choice (Asterisk/FreeSWITCH/Kamailio), Whisper model size, server IP.

8.2 Enable VoiceBot for a tenant
# Step 1: Enable bot features (superadmin)
curl -X PUT http://SERVER:4000/api/tenant/TENANT_ID/bot/features \
  -H "Authorization: Bearer SUPERADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"features\":{\"bot_enabled\":true,\"inbound_bot\":true,\"bot_rasa\":true}}"

# Step 2: Configure Rasa bot (tenant admin)
curl -X PUT http://SERVER:4000/api/tenant/TENANT_ID/bot/config \
  -H "Authorization: Bearer TENANT_ADMIN_JWT" \
  -d "{\"bot_type\":\"rasa\",\"enabled\":true,\"rasa_url\":\"http://127.0.0.1:5005\"}"

# Step 3: Create bot agent on extension 9000
curl -X POST http://SERVER:4000/api/tenant/TENANT_ID/bot/agents \
  -d "{\"name\":\"Support Bot\",\"extension\":\"9000\",\"bot_type\":\"rasa\",\"direction\":\"inbound\"}"

8.3 Create outbound campaign
curl -X POST http://SERVER:4000/api/tenant/TENANT_ID/bot/campaigns \
  -H "Authorization: Bearer TENANT_ADMIN_JWT" \
  -d "{\"name\":\"Reminder calls\",\"bot_type\":\"claude\",
  \"contacts\":[{\"name\":\"John\",\"phone\":\"+12025551234\"}],
  \"script\":{\"greeting\":\"Hello {name}, this is VoiceBot from Demo Corp.\"} }"

# Start the campaign
curl -X POST http://SERVER:4000/api/tenant/TENANT_ID/bot/campaigns/CAMPAIGN_ID/start

8.4 Service management
Action	Command
Start	systemctl start techlife-voicebridge
Stop	systemctl stop techlife-voicebridge
Restart	systemctl restart techlife-voicebridge
Logs	journalctl -u techlife-voicebridge -f
Setup DBs	cd /opt/techlife-voicebridge && node scripts/setup-db.js
Deploy PBX configs	sudo node scripts/setup-pbx.js
Seed demo data	node scripts/seed.js
Dashboard	http://YOUR_SERVER (port 80 via Nginx)
Swagger API	http://YOUR_SERVER:4000/api-docs
Webhook test	http://YOUR_SERVER:5000/webhook/test

