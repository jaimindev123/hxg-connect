# HXG Connect CRM — Self-Owned Call Recording & Telephony (Doc 07)

Goal: remove dependence on third-party telephony aggregators (Exotel/Knowlarity/etc.) for calling and recording. Three architectures, all pluggable behind the existing `TelephonyProvider` adapter interface — the CRM code never changes.

---

## Architecture A — Self-Hosted PBX (own switch)

```
 CRM (click-to-call)                    ┌────────────────────────────┐
   │ REST: originate(agent, customer)   │  Licensed Operator (India: │
   ▼                                    │  Airtel / Tata / BSNL)     │
┌───────────────────────────┐  SIP/RTP  │  · SIP trunk (per-channel) │
│ FreeSWITCH cluster (2+)   │◄─────────►│  · DID numbers (virtual #) │
│ · originate & bridge legs │           └────────────────────────────┘
│ · record_session → file   │
│ · IVR / whisper / barge   │──► recording file ──► S3 (encrypted)
│ · ESL events              │──► call events ──► CRM webhook (same
└───────────────────────────┘      normalized shape as Exotel events)
        │
   Kamailio (SIP load balancer / registrar)  ·  Homer (SIP capture/debug)
```

**Stack:** FreeSWITCH (media + recording) + Kamailio (SIP proxy/LB) + `mod_event_socket` (ESL) for real-time events + a thin **`selfhost.adapter.ts`** implementing the same interface as other providers (`originate()`, `normalizeEvent()`, `fetchRecording()`).

**Call flow (click-to-call):** CRM → adapter → FreeSWITCH originates leg-1 to agent (SIP softphone/app or agent's mobile) → on answer, originates leg-2 to customer via trunk → bridges → `record_session` starts (after playing the consent announcement) → on hangup, ESL emits normalized `call.completed` + recording is uploaded to S3 → existing pipeline (auto-log, disposition prompt, signed playback URLs) takes over unchanged.

**What you gain:** raw trunk pricing (~₹0.15–0.30/min vs ~₹0.40–0.60 aggregated), zero per-recording fees, full feature control (whisper, barge, conference, custom IVR, voicemail-drop), no vendor limits, recordings never touch a third party.

**What you take on:** SIP/RTC engineering skill (codecs, NAT, jitter, carrier quirks), HA ops (an outage stops calling for *all* clients — run active-active across zones), capacity planning (1 concurrent call ≈ 1 trunk channel), fraud protection (toll-fraud firewalling is mandatory — compromised PBXs get abused within hours), and carrier relationships per region.

**India compliance:** trunks must come from licensed telecom operators; internet-to-PSTN toll bypass is illegal — keep media paths through the operator trunk. The 2023 OSP deregulation removed most registration burden for domestic call centers, but keep CDRs and recording-consent announcements. Per-client outbound caller-ID (DID) must be provisioned through the operator.

---

## Architecture B — SIM-Based Mobile Recording (field/telecaller pattern)

Agent dials from a normal SIM; the HXG Connect Android app records on-device and syncs.

```
Android app (company device, MDM/sideloaded)
 · detects outgoing/incoming call to a CRM contact
 · records audio on-device (OEM/ROM permitting)
 · on hangup: uploads {audio, number, direction, duration,
   timestamps, device_id} → POST /calls/sim-log
 · offline-safe: queued locally, synced later (late-sync flagged)
CRM matches number → lead → same call record, same playback UI
```

**Hard constraints (be honest with buyers):**
- Android 10+ removed public call-recording APIs; Google Play bans accessibility-API recording (2022). Therefore this module ships **outside the Play Store**: enterprise MDM deployment or signed APK on company-issued devices, standardized on OEMs that permit recording. Document this in sales collateral — it is how every Indian SIM-recording CRM actually operates.
- **iOS: not possible** for SIM calls. iPhone users get Architecture C.
- Quality/consistency varies by OEM; treat SIM recordings as best-effort, PBX/VoIP recordings as guaranteed.

**Why keep it anyway:** zero per-minute cost, works with the personal-touch of a real mobile number, and field reps need nothing new — the app they already use for check-ins does the logging.

---

## Architecture C — In-App VoIP (WebRTC) — recommended end-state for agents

Calls are placed inside the HXG Connect app/web over the internet → your FreeSWITCH → operator trunk → customer's normal phone.

- You own the entire media path ⇒ recording is trivial and **identical on Android, iOS, and web** (no OS restrictions).
- Perfect metadata (talk time, hold, transfer), live supervisor listen/whisper/barge, real-time transcription hooks (feeds the Phase-5 call-QA scoring).
- Needs decent agent bandwidth; fall back to Architecture A's mobile-leg bridging on poor networks (adapter decides per call).
- This is simply the front-end of Architecture A — same switch, same trunk, same adapter.

---

## Recording Pipeline (common to all three)

1. Consent announcement played (A/C) or app disclosure shown (B) — DPDP/GDPR requirement.
2. Media captured → encrypted at rest → uploaded to S3 with key `tenant/{id}/calls/{call_id}.ogg` (Opus ~12 kbps ≈ 5–6 MB/hour — storage is cheap; 1M minutes ≈ 100 GB).
3. `calls` row updated with `recording_key`, duration, provider=`selfhost|sim|webrtc`.
4. Playback via time-limited signed URLs, role-gated, every play audit-logged (already in the schema — no changes needed).
5. Retention job per tenant policy (default 180 days; legal-hold override).

**Schema impact:** none structural. `calls.provider` gains values `selfhost`, `sim`, `webrtc`; add `calls.recording_source text` (`pbx|device|webrtc`) and `calls.consent_played boolean`.

---

## Decision Framework & Rollout

| Stage | Monthly call volume | Use |
|---|---|---|
| Launch → PMF | < 1 lakh min | Aggregators only (Exotel first). Zero telecom ops. |
| Growth | 1–5 lakh min | Add SIM-recording Android module for field teams (immediate cost win, no infra). |
| Scale | > 3–5 lakh min | Stand up FreeSWITCH + operator trunks; migrate clients trunk-by-trunk behind the adapter. Break-even on infra+2 telephony engineers typically lands here. |
| Maturity | — | WebRTC in-app dialing as the default agent experience; aggregators retained as failover routes. |

**Sellable angle:** per-client telephony choice via plan feature-flags — *"use our cloud minutes, bring your own Exotel/Twilio, or dedicated self-hosted trunks (Enterprise)"* — all on one codebase because of the adapter layer.

**Build estimate:** Architecture A MVP (originate, bridge, record, events, one operator trunk, HA pair) ≈ 6–8 weeks for one experienced VoIP engineer + one backend dev; SIM module ≈ 4 weeks Android; WebRTC softphone ≈ 4–6 weeks on top of A.
