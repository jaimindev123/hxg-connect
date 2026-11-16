# Lead integration guide

The guide itself is a page served by the app, so clients and third-party developers can open it without signing in:

- Live: `https://hxgconnect.com/integration-guide.html` (examples show that server's own address)
- Source: `apps/web/public/integration-guide.html`

## What's behind it

| Piece | Where |
|---|---|
| Connector endpoint `POST /api/webhooks/in/{source}/{key}` | `apps/api/src/tenant/connectors.ts` |
| Platform list, setup steps, reply style per platform | `SOURCES` in the same file |
| Payload reader (any field names, nested, label/value lists) | `mapAnyPayload`, `mapFor` |
| Setup screen (address, steps, Send test, deliveries) | `ConnectorSetup` in `apps/web/src/lib/Integrations.tsx` |
| WordPress plugin source | `integrations/wordpress/hxg-connect-leads/` |
| Plugin download served to clients | `apps/web/public/downloads/hxg-connect-leads.zip` |

## Adding a platform

1. Add an entry to `SOURCES` (id, name, group, steps, `reply`).
2. If its payload has a fixed shape the generic reader gets wrong, add a branch in `mapFor`.
3. Add a section with the same `id` to the guide page, and a test with the platform's documented payload.

## Rebuilding the plugin zip after editing the plugin

    cd integrations/wordpress && zip -r ../../apps/web/public/downloads/hxg-connect-leads.zip hxg-connect-leads

## Checked against, and not yet checked against

Payload shapes follow each platform's published format (IndiaMART Push API, Shopify webhooks, Typeform, Jotform, Tally, Elementor). The WordPress plugin's code runs in the test suite against the API with WordPress's functions stubbed. None of it has been run against a live account on those platforms yet. JustDial's and Sulekha's field names are not published; the reader is name-tolerant and anything unread lands in "Couldn't be added" with the raw payload, which is the thing to send back if a field is missed.
