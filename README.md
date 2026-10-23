# Devaux WhatsApp Service

A starter Dockerized WhatsApp Web companion service for Devaux Operations.

## What it does in Version 1

- Runs 4 WhatsApp sessions: `dog_food`, `by_sea`, `cool_pool`, `candock`
- Shows QR codes for linking each business phone
- Saves inbound WhatsApp messages to Supabase
- Saves outbound messages to Supabase
- Provides a send-message API
- Stores auth sessions on disk so QR scanning is not needed every restart

## Important

This uses WhatsApp Web style automation through Baileys. It is cheaper than Respond.io, but it is not the official WhatsApp Business Platform. Treat it as an internal operations tool.

## Setup

### 1. Create Supabase tables

Run:

```sql
supabase/001_whatsapp_tables.sql
```

in Supabase SQL Editor.

### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

Set:

```env
ADMIN_SECRET=make-this-long-and-private
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PUBLIC_BASE_URL=http://your-server-ip:3030
BUSINESSES=dog_food,by_sea,cool_pool,candock
```

Do not put your service role key in public GitHub.

### 3. Run locally or on DigitalOcean

```bash
docker compose up -d --build
```

View logs:

```bash
docker logs -f devaux-whatsapp
```

### 4. Open admin QR page

```text
http://YOUR_SERVER_IP:3030/admin?secret=YOUR_ADMIN_SECRET
```

For each business:
1. Open the matching business phone.
2. Open WhatsApp.
3. Go to Linked Devices.
4. Link a Device.
5. Scan the QR code.

## Test sending a message

```bash
curl -X POST "http://YOUR_SERVER_IP:3030/api/send" \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: YOUR_ADMIN_SECRET" \
  -d '{
    "businessSlug": "dog_food",
    "to": "17581234567",
    "body": "Test message from Devaux Operations"
  }'
```

Use country code in the phone number.

## Inbox AI agent bridge (off by default)

`src/agent/` connects this service to the inbox's AI agent. The inbox decides
everything (eligibility, replies, `#E-XXXXX` escalations, staff commands,
takeover, order requests, audit). This service forwards live messages to
`/api/bridge/ai-agent/message`, sends only the returned `send: true` items
verbatim, and acks each one. It never forwards history imports, scheduled
sends or its own sends. Disabled unless `AGENT_ENABLED=true`. Sends nothing
unless `AGENT_SEND_ENABLED=true` and the inbox has the business in Assisted
mode. The contract is `docs/ai-agent-bridge-contract.md` in the inbox repo.
Bridge specifics are in `docs/ai-agent/BRIDGE.md`.

```bash
npm run typecheck
npm test
```

## Suggested next version

- Add a Devaux Operations inbox page
- Add Supabase realtime
- Add AI suggested replies
- Add contact/customer profiles
- Add n8n triggers for new messages
