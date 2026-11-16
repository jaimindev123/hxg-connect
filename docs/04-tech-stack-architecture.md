# HXG Connect CRM — Tech Stack, Architecture & Folder Structure

## Recommended Stack

| Layer | Choice | Why |
|---|---|---|
| Web frontend | **React 19 + TypeScript + Vite**, TanStack Query/Router/Table, Zustand, Tailwind + shadcn/ui, dnd-kit (kanban), Recharts | Fast to build, huge hiring pool, first-class data-grid & drag-drop |
| Mobile | **React Native (Expo)** + WatermelonDB (offline sync), FCM/APNs, expo-location, expo-av (voice notes) | One team ships iOS+Android; true offline-first local DB |
| API | **Node.js (NestJS) + TypeScript** | Structured modules/guards/interceptors map cleanly to RBAC + multi-tenancy; shared types with frontends |
| Database | **PostgreSQL 16** (RLS, partitioning) via Prisma/Drizzle | See schema doc |
| Cache/queues | **Redis** (cache, rate limits, socket presence) + **BullMQ** workers | Assignment engine, sequences, webhooks, imports, recording fetch |
| Search | Postgres FTS → **Meilisearch/OpenSearch** at scale | Global ⌘K search, fuzzy dedupe |
| Analytics store | **ClickHouse** (phase 3, via Debezium CDC) | Sub-second reports at 50M+ rows |
| Object storage | S3 / R2 | Recordings, documents, media; signed URLs |
| Realtime | Socket.IO (Redis adapter) | Screen-pops, live dashboards |
| Auth | **Keycloak** or Auth.js + custom RBAC | OIDC, SSO-ready for enterprise |
| Infra | Docker → **Kubernetes (EKS/GKE) or ECS**, Terraform, GitHub Actions, Cloudflare CDN/WAF | Zero-downtime deploys, autoscaling workers |
| Observability | OpenTelemetry + Grafana/Loki/Tempo, Sentry | P95 tracking per tenant |
| Docs/mail/pdf | SES/SendGrid, Puppeteer/Gotenberg (PDF gen), Meta WA Cloud API / Gupshup, MSG91/Twilio (SMS) | |

**Architecture shape:** start as a **modular monolith** (NestJS modules = bounded contexts: leads, telephony, messaging, inventory, billing, cp, reports) sharing one Postgres. Extract only telephony-webhook ingestion and the reporting warehouse into separate services when volume demands. This is how you stay fast with a small team *and* keep clean seams for scale.

```
 Clients: Web SPA · iOS/Android · CP Portal
        │ HTTPS / WSS
 ┌──────▼──────────────────────────────┐
 │  API Gateway (rate limit, authn)    │
 ├─────────────────────────────────────┤
 │  NestJS App (modular monolith)      │──► Redis (cache/pubsub)
 │  · REST /api/v1  · WS  · Webhooks   │──► BullMQ Workers:
 │  · RBAC guard · tenant RLS ctx      │      assignment · sequences · imports
 └───────┬───────────────┬─────────────┘      recordings · exports · tally sync
         │               │
   PostgreSQL 16     S3 storage          Integrations: Exotel/Twilio · Meta WA
   (RLS+partitions)  (recordings/docs)   FB/Google Ads · Razorpay/Stripe ·
         │                               Google/Outlook Cal · Zoom/Meet · Maps
   Debezium CDC ──► ClickHouse (reports, phase 3)
```

## Folder Structure (monorepo, pnpm + Turborepo)

```
hxg-connect/
├── apps/
│   ├── api/                          # NestJS
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── auth/             # oidc, jwt, mfa, sessions
│   │   │   │   ├── tenancy/          # tenant context, RLS middleware
│   │   │   │   ├── users/  teams/  roles/
│   │   │   │   ├── leads/            # controller, service, dedupe.service,
│   │   │   │   │                     # assignment.engine, merge.service
│   │   │   │   ├── contacts/  pipelines/  followups/  meetings/
│   │   │   │   ├── telephony/
│   │   │   │   │   ├── providers/    # exotel.adapter, knowlarity.adapter,
│   │   │   │   │   │                 # myoperator.adapter, twilio.adapter, sip.adapter
│   │   │   │   │   └── recordings/   # fetch worker, signed-url service
│   │   │   │   ├── messaging/        # whatsapp/ sms/ email/ templates/ sequences/
│   │   │   │   ├── site-visits/  inventory/  bookings/  payments/
│   │   │   │   ├── channel-partners/ campaigns/  documents/  tickets/
│   │   │   │   ├── reports/  dashboards/  search/
│   │   │   │   ├── notifications/  webhooks/  integrations/
│   │   │   │   └── admin/  audit/  custom-fields/
│   │   │   ├── common/               # guards, interceptors, pagination, problem+json
│   │   │   ├── jobs/                 # BullMQ processors
│   │   │   └── main.ts
│   │   └── test/
│   ├── web/                          # React SPA
│   │   └── src/
│   │       ├── app/                  # router, providers, layouts
│   │       ├── features/             # leads/ pipeline/ calls/ inbox/ visits/
│   │       │                         # inventory/ bookings/ reports/ admin/ …
│   │       ├── components/ui/        # design system
│   │       ├── lib/                  # api client (generated), ws, auth, utils
│   │       └── stores/
│   ├── mobile/                       # Expo RN
│   │   └── src/{screens,features,db(watermelon),sync,components,lib}
│   ├── cp-portal/                    # lightweight Next.js portal for partners
│   └── platform/                     # Super Admin console (Next.js, separate auth realm)
│       └── src/{tenants,plans,billing,impersonation,health,analytics}
├── packages/
│   ├── shared/                       # zod schemas, TS types, enums, permissions map
│   ├── api-client/                   # openapi-generated typed client
│   └── config/                       # eslint, tsconfig, tailwind presets
├── infra/                            # terraform/, k8s/, docker/
├── docs/                             # this design pack, ADRs, runbooks
└── turbo.json  pnpm-workspace.yaml
```

## Cross-cutting Decisions

- **Multi-tenancy:** shared schema + `tenant_id` + Postgres RLS set per-request from the JWT. Cheapest to operate; enterprise tenants can be moved to dedicated DBs later (the RLS pattern makes both work).
- **Permissions:** a single `permissions.map.ts` in `packages/shared` is the source of truth; API guards and UI feature-flags both read it, so the UI never shows what the API would deny.
- **Phone-number canonicalization:** everything stored E.164; one `PhoneService` used by capture, dedupe, telephony matching, and WhatsApp.
- **Provider adapters:** telephony, WhatsApp BSPs, SMS, and payment gateways each sit behind one interface — adding Knowlarity after Exotel is a new file, not a refactor.
- **Idempotency everywhere:** webhook ingestion and payment events are dedup-keyed; retries are safe.
- **Audit by default:** a Nest interceptor writes `audit_log` diffs on mutating routes; exports and recording playback are logged as *read* events.
