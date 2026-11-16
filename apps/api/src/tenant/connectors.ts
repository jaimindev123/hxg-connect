import { BadRequestException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Db } from '../db/db.service';
import { TenantGuard, TenantRoles } from '../common/guards';
import { unseal } from '../common/crypto';
import { parseBudget } from './lead-intake';
import { mapPropertyType } from './capture.controllers';
import { PortalIntake } from './portals';

/**
 * Lead connectors: one address per platform,
 *   POST /api/webhooks/in/{source}/{key}
 * for every system that can send a lead to a URL: website builders, form
 * tools, marketplaces, automation tools, or a developer's own code.
 *
 * Platforms don't agree on field names ("Mobile", "your-tel", "SENDER_MOBILE",
 * "phone_number"), so the mapper below reads any payload shape instead of
 * asking each client to map fields by hand.
 */
export interface SourceDef {
  id: string;                     // also the lead's source
  name: string;
  group: 'Websites and stores' | 'Form builders' | 'Marketplaces and directories' | 'Automation tools' | 'Your own system';
  /** How the address gets set up: by the client, or by the platform's team. */
  setup: 'self' | 'account_manager';
  steps: string[];
  /** lenient: answer 200 even when a lead can't be read (it waits in review),
   *  because these platforms switch a webhook off after repeated errors.
   *  strict: answer 422 so whoever is building the connection sees the problem. */
  reply: 'lenient' | 'strict';
  get?: boolean;                  // also delivers by GET with query parameters
  sign?: 'shopify' | 'typeform';  // optional signature check
}

export const SOURCES: SourceDef[] = [
  { id: 'wordpress', name: 'WordPress', group: 'Websites and stores', setup: 'self', reply: 'strict', steps: [
    'Download the HXG Connect Leads plugin and install it in WordPress: Plugins > Add New > Upload Plugin.',
    'Open Settings > HXG Connect Leads, paste this address and save.',
    'Press "Send test lead" on that page. Every form on the site now sends its enquiries here: Contact Form 7, WPForms, Elementor, Gravity Forms, Ninja Forms, Fluent Forms, Formidable, and WooCommerce orders if you tick that box.',
    'Using only Elementor Pro and no plugin? In the form widget, add Actions After Submit > Webhook and paste this address.' ] },
  { id: 'shopify', name: 'Shopify', group: 'Websites and stores', setup: 'self', reply: 'lenient', sign: 'shopify', steps: [
    'In Shopify admin, open Settings > Notifications > Webhooks and press Create webhook.',
    'Event: Customer creation. Format: JSON. URL: this address. Save.',
    'Add a second webhook for Order creation if buyers should arrive as leads too.',
    'Copy the signing secret Shopify shows under the webhook list into "Shopify webhook signing secret" above and save, so only Shopify can post here.',
    'Customers who give only an email wait in "Needs review": make the phone number required at checkout to avoid that.' ] },
  { id: 'wix', name: 'Wix', group: 'Websites and stores', setup: 'self', reply: 'lenient', steps: [
    'In your Wix dashboard, open Automations and create a new automation.',
    'Trigger: Wix Forms > Form submitted. Action: Send via webhook.',
    'Paste this address as the target URL, keep "All keys and values", and activate.' ] },
  { id: 'webflow', name: 'Webflow', group: 'Websites and stores', setup: 'self', reply: 'lenient', steps: [
    'In Site settings, open Apps & integrations and scroll to Webhooks.',
    'Add a webhook. Trigger type: Form submission. URL: this address.',
    'Publish the site and submit the form once to confirm.' ] },

  { id: 'google_forms', name: 'Google Forms', group: 'Form builders', setup: 'self', reply: 'strict', steps: [
    'Open the form, press the three dots and choose Apps Script.',
    'Paste the short script from the integration guide (section "Google Forms") and put this address in it.',
    'In Apps Script, open Triggers > Add trigger > On form submit, and approve the permission prompt.' ] },
  { id: 'typeform', name: 'Typeform', group: 'Form builders', setup: 'self', reply: 'lenient', sign: 'typeform', steps: [
    'Open the form, go to Connect > Webhooks and press Add a webhook.',
    'Paste this address and switch the webhook on.',
    'Optional: set a secret on the webhook and save the same secret in "Typeform webhook secret" above.',
    'Use Typeform\'s Phone number and Email question types so the number is always recognised.' ] },
  { id: 'jotform', name: 'Jotform', group: 'Form builders', setup: 'self', reply: 'lenient', steps: [
    'Open the form, go to Settings > Integrations and choose WebHooks.',
    'Paste this address and press Complete Integration.' ] },
  { id: 'tally', name: 'Tally', group: 'Form builders', setup: 'self', reply: 'lenient', steps: [
    'Open the form, go to Integrations and connect Webhooks.',
    'Paste this address as the endpoint URL and connect.' ] },

  { id: 'indiamart', name: 'IndiaMART', group: 'Marketplaces and directories', setup: 'self', reply: 'lenient', steps: [
    'Sign in at seller.indiamart.com and open Lead Manager.',
    'Open the three-dots menu and choose Push API (under Import/Export Leads).',
    'Choose Other as the CRM, type "HXG Connect" as the platform name and paste this address as the webhook URL.',
    'Confirm the OTP IndiaMART sends to your primary mobile number, then use their test button. The test lead appears under Recent deliveries.' ] },
  { id: 'justdial', name: 'JustDial', group: 'Marketplaces and directories', setup: 'account_manager', reply: 'lenient', get: true, steps: [
    'JustDial sets this up on their side. Press "Email account manager" to send them this address.',
    'Ask them for a test lead once it\'s configured, and watch it arrive under Recent deliveries.' ] },
  { id: 'sulekha', name: 'Sulekha', group: 'Marketplaces and directories', setup: 'account_manager', reply: 'lenient', get: true, steps: [
    'Sulekha sets this up on their side. Press "Email account manager" to send them this address.',
    'Ask them for a test lead once it\'s configured, and watch it arrive under Recent deliveries.' ] },

  { id: 'zapier', name: 'Zapier', group: 'Automation tools', setup: 'self', reply: 'strict', steps: [
    'In your Zap, add the action Webhooks by Zapier > POST.',
    'URL: this address. Payload type: json.',
    'Under Data, add name, phone, email and message, and map each to the trigger\'s fields. Test the step.',
    'This is also the route for LinkedIn Lead Gen Forms, TikTok lead ads, Calendly and anything else Zapier can read.' ] },
  { id: 'make', name: 'Make', group: 'Automation tools', setup: 'self', reply: 'strict', steps: [
    'Add the module HTTP > Make a request.',
    'URL: this address. Method: POST. Body type: Raw, content type JSON.',
    'Request content: {"name": "...", "phone": "...", "email": "...", "message": "..."} mapped from the earlier modules. Run once.' ] },
  { id: 'pabbly', name: 'Pabbly Connect', group: 'Automation tools', setup: 'self', reply: 'strict', steps: [
    'Add the action API (Pabbly) > Execute custom request, or Webhook by Pabbly.',
    'Method: POST. URL: this address. Payload type: JSON.',
    'Add the parameters name, phone, email and message, mapped from the trigger. Save and send a test request.' ] },
  { id: 'n8n', name: 'n8n', group: 'Automation tools', setup: 'self', reply: 'strict', steps: [
    'Add an HTTP Request node. Method: POST. URL: this address.',
    'Send body as JSON with name, phone, email and message. Execute the node.' ] },

  { id: 'custom', name: 'Any other platform', group: 'Your own system', setup: 'self', reply: 'strict', get: true, steps: [
    'Have the platform POST each lead to this address as JSON or form data. Nothing else is needed: the address itself identifies your workspace.',
    'Send a name and a mobile number at minimum. Common field names are recognised automatically (name, phone, mobile, email, message, city, budget, project).',
    'Add ?source=your_platform_name to the address to label where these leads came from.',
    'A 200 reply with "status":"success" means the lead was added. The integration guide has examples and the full field list.' ] },
];
export const findSource = (id: string) => SOURCES.find(s => s.id === id);

// ---------------------------------------------------------------------
// Reading any payload
// ---------------------------------------------------------------------
const nk = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
const WRAPPER_LEAF = new Set(['value', 'rawvalue', 'full', 'text', 'answer']);
const CONTAINER = /^(form|meta|site|shop|store|page|campaign|ad|adset|event|plugin|definition)$/;
const scalar = (v: unknown) => v !== null && v !== undefined && typeof v !== 'object';

/** `{label:"Phone", value:"98…"}`, `{name:"email", values:["a@b.c"]}`, `{key, answer}` → [label, value]. */
function asPair(o: any): [string, string] | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const label = [o.label, o.title, o.question, o.name, o.key, o.field].find(x => typeof x === 'string' && x.trim());
  const raw = 'value' in o ? o.value : 'answer' in o ? o.answer : 'values' in o ? o.values : undefined;
  if (!label || raw === undefined) return null;
  const one = (x: any): string => scalar(x) ? String(x) : x && typeof x === 'object' ? String(x.full ?? x.text ?? x.label ?? x.value ?? '') : '';
  const value = (Array.isArray(raw) ? raw.map(one).filter(Boolean).join(', ') : one(raw)).trim();
  return value ? [label, value] : null;
}

type Entry = { k: string; v: string; depth: number; used?: boolean };

/** Breadth-first, so a top-level "email" wins over one buried in an address
 *  book. Wrapper leaves ("fields[name][value]") take their parent's name. */
function flatten(root: unknown): Entry[] {
  const out: Entry[] = [];
  const queue: { node: any; key: string; depth: number }[] = [{ node: root, key: '', depth: 0 }];
  for (let seen = 0; queue.length && seen < 4000; seen++) {
    const { node, key, depth } = queue.shift()!;
    if (node === null || node === undefined) continue;
    if (scalar(node)) { const v = String(node).trim(); if (v && key) out.push({ k: key, v: v.slice(0, 5000), depth }); continue; }
    if (depth > 7) continue;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 200)) {
        const pair = asPair(item);
        if (pair) out.push({ k: nk(pair[0]), v: pair[1].slice(0, 5000), depth });
        else queue.push({ node: item, key, depth: depth + 1 });
      }
      continue;
    }
    for (const [rawKey, v] of Object.entries(node)) {
      let k = nk(rawKey).replace(/^q\d+(?=[a-z])/, '');           // Jotform: q3_name, q5_phoneNumber
      if (WRAPPER_LEAF.has(k) && key) k = key;
      else if (CONTAINER.test(key) && /^(name|id|title|url)$/.test(k)) k = key + k;   // form[name] is the form's name, not the buyer's
      const pair = asPair(v);                                     // Elementor: fields[x] = {title:"Mobile", value:"98…"}
      if (pair) out.push({ k: nk(pair[0]), v: pair[1].slice(0, 5000), depth: depth + 1 });
      queue.push({ node: v, key: k || key, depth: depth + 1 });
    }
  }
  return out;
}

const cleanPhone = (v: string) => { const t = v.trim(); const d = t.replace(/\D/g, ''); return d.length >= 7 && d.length <= 15 ? (t.startsWith('+') ? `+${d}` : d) : ''; };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const A = {
  phone: ['mobile', 'phone', 'mobileno', 'mobilenumber', 'phonenumber', 'phoneno', 'contact', 'contactno', 'contactnumber', 'tel', 'telephone',
    'whatsapp', 'whatsappnumber', 'sendermobile', 'buyermobile', 'customermobile', 'usermobile', 'senderphone', 'cell', 'cellphone',
    'yourphone', 'yourtel', 'yourmobile', 'yournumber', 'billingphone'],
  email: ['email', 'emailid', 'emailaddress', 'senderemail', 'buyeremail', 'youremail', 'useremail', 'contactemail', 'customeremail', 'billingemail', 'mail'],
  name: ['name', 'fullname', 'yourname', 'sendername', 'buyername', 'contactname', 'customername', 'leadname', 'username', 'contactperson', 'displayname'],
  first: ['firstname', 'first', 'fname', 'givenname', 'billingfirstname'],
  last: ['lastname', 'last', 'lname', 'surname', 'familyname', 'billinglastname'],
  message: ['message', 'yourmessage', 'query', 'querymessage', 'comments', 'comment', 'enquiry', 'inquiry', 'requirement', 'requirements', 'remarks', 'description', 'note', 'notes', 'msg', 'details'],
  about: ['project', 'projectname', 'product', 'productname', 'queryproductname', 'propertyname', 'property', 'listingname', 'subject', 'yoursubject', 'service', 'interestedin', 'category', 'querymcatname', 'keywords'],
  city: ['city', 'sendercity', 'location', 'locality', 'area', 'preferredlocation', 'localities', 'billingcity'],
  budget: ['budget', 'budgetmax', 'budgetrange', 'yourbudget'],
  ptype: ['propertytype', 'unittype', 'configuration', 'bhk'],
  company: ['company', 'companyname', 'sendercompany', 'organisation', 'organization', 'businessname'],
  id: ['uniquequeryid', 'leadid', 'eventid', 'submissionid', 'entryid', 'responseid', 'enquiryid', 'queryid'],
};
const KEEP = ['utmsource', 'utmmedium', 'utmcampaign', 'utmcontent', 'utmterm', 'pageurl', 'formname', 'formid', 'gclid', 'fbclid', 'referrer', 'pincode', 'state', 'senderstate'];
const NEVER = /key|token|secret|hmac|signature|password|nonce|captcha|honeypot|consent|gdpr|acceptance|^code$|^status$|^method$|^json$|^timeout$|^url$/;
const NOT_A_PERSON = /form|company|project|product|property|listing|society|campaign|page|site|shop|store|file|field|event|category|mcat|business|plugin|vendor|variant|gateway|source|display|tag|^ad/;

export interface Mapped { lead: Record<string, unknown>; extId?: string }

/** Any payload → a lead. `source` becomes the lead's source. */
export function mapAnyPayload(source: string, body: unknown, label = source): Mapped {
  const entries = flatten(body);
  const take = (keys: string[], ok: (v: string) => boolean = () => true) => {
    for (const k of keys) { const e = entries.find(x => x.k === k && !x.used && ok(x.v)); if (e) { e.used = true; return e.v; } }
    return undefined;
  };
  const fuzzy = (re: RegExp, not: RegExp | null, ok: (v: string) => boolean) => {
    const e = entries.find(x => !x.used && re.test(x.k) && !(not && not.test(x.k)) && ok(x.v));
    if (e) e.used = true;
    return e?.v;
  };
  const isPhone = (v: string) => !!cleanPhone(v) && /^[+\d\s\-().]+$/.test(v.trim());
  const isEmail = (v: string) => EMAIL.test(v.trim());

  const OTHER_NUMBER = /alt|receiver|dnc|office|fax|company|landline|virtual/;
  const phone = take(A.phone, isPhone)
    ?? fuzzy(/mobile|phone|whatsapp|contactn|^tel|tel$|cell/, OTHER_NUMBER, isPhone)
    ?? fuzzy(/mobile|phone/, /receiver|dnc|fax|virtual/, isPhone);           // an alternate number beats none
  const email = take(A.email, isEmail) ?? fuzzy(/mail/, /alt|receiver|admin|shop|store|site|from|to$/, isEmail);
  let name = take(A.name, v => v.length <= 160 && !isEmail(v) && !/^#?\d+$/.test(v));
  if (!name) { const f = take(A.first), l = take(A.last); name = [f, l].filter(Boolean).join(' ') || undefined; }
  name ??= fuzzy(/name$/, NOT_A_PERSON, v => v.length <= 160 && !isEmail(v));
  const message = take(A.message) ?? fuzzy(/message|comment|enquiry|inquiry|requirement/, null, () => true);
  const about = take(A.about, v => v.length <= 200);
  const city = take(A.city, v => v.length <= 80);
  const budget = parseBudget(take(A.budget));
  const ptype = mapPropertyType(take(A.ptype) ?? about ?? message);
  const company = take(A.company, v => v.length <= 160);
  const extId = take(A.id, v => v.length <= 120);

  const custom: Record<string, string> = { connector: source };
  if (about) custom.enquired_about = about.slice(0, 300);
  if (company) custom.company = company;
  if (extId) custom.external_id = extId;
  for (const e of entries) {
    if (e.used || e.v.length > 300 || Object.keys(custom).length >= 18) continue;
    if (KEEP.includes(e.k) || (e.depth <= 1 && !NEVER.test(e.k) && e.k.length <= 40)) { custom[e.k] ??= e.v; e.used = true; }
  }

  return { extId, lead: {
    name: (name || (email ? email.split('@')[0] : '') || `${label} enquiry`).slice(0, 160),
    phone: phone ? cleanPhone(phone) : '', email: email?.trim().toLowerCase(),
    source, budget_max: budget, property_type: ptype,
    preferred_locations: city ? [city] : [], tags: [], custom_fields: custom,
    note: [about && `Enquired about ${about}`, message].filter(Boolean).join('. ').slice(0, 5000) || undefined,
  } };
}

/** Shopify customers and orders: fixed shape, and an order's "name" is "#1001". */
function shopifyPayload(b: any, topic: string): unknown {
  const c = b?.customer && typeof b.customer === 'object' ? b.customer : b ?? {};
  const addr = b?.billing_address ?? b?.shipping_address ?? c?.default_address ?? c?.addresses?.[0] ?? {};
  const isOrder = Array.isArray(b?.line_items);
  const items = isOrder ? b.line_items.slice(0, 8).map((i: any) => i?.title ?? i?.name).filter(Boolean).join(', ') : '';
  return {
    name: [c.first_name, c.last_name].filter(Boolean).join(' ') || addr.name || '',
    phone: b?.phone || c.phone || addr.phone || c?.default_address?.phone || '',
    email: b?.email || b?.contact_email || c.email || '',
    city: addr.city || '', company: addr.company || '',
    message: isOrder ? `Shopify order ${b.name ?? ''}${b.total_price ? `, ${b.currency ?? ''} ${b.total_price}` : ''}${items ? `: ${items}` : ''}`.trim() : (c.note || ''),
    product: items.slice(0, 200), shopify_topic: topic, shopify_tags: c.tags || '',
  };
}

/** Typeform keeps question titles apart from answers: join them up. */
function typeformPayload(b: any): unknown {
  const fr = b?.form_response;
  if (!fr || !Array.isArray(fr.answers)) return b;
  const titles = new Map<string, string>((fr.definition?.fields ?? []).map((f: any) => [f.id, f.title]));
  const out: any = { event_id: b.event_id, form_name: fr.definition?.title, ...(fr.hidden ?? {}), fields: [] as any[] };
  for (const a of fr.answers) {
    const raw = a?.[a?.type];
    const v = scalar(raw) ? String(raw) : raw?.label ?? raw?.labels?.join(', ') ?? raw?.other ?? '';
    if (!v) continue;
    if (a.type === 'phone_number') out.phone ??= v;
    else if (a.type === 'email') out.email ??= v;
    else out.fields.push({ label: titles.get(a.field?.id) ?? a.field?.ref ?? 'answer', value: v });
  }
  return out;
}

const INDIAMART_TYPES: Record<string, string> = { W: 'Direct enquiry', B: 'Buy lead', P: 'Phone call', BIZ: 'Catalogue view', WA: 'WhatsApp enquiry' };

export function mapFor(def: SourceDef, body: any, req?: Request): Mapped {
  let b = body, source = def.id, label = def.name;
  if (def.id === 'shopify') b = shopifyPayload(body, String(req?.headers['x-shopify-topic'] ?? ''));
  else if (def.id === 'typeform') b = typeformPayload(body);
  else if (def.id === 'indiamart') {
    b = body?.RESPONSE ?? body?.body?.RESPONSE ?? body;
    if (b && typeof b === 'object' && INDIAMART_TYPES[b.QUERY_TYPE]) b = { ...b, QUERY_TYPE: undefined, enquiry_type: INDIAMART_TYPES[b.QUERY_TYPE] };
  } else if (def.id === 'jotform' && typeof body?.rawRequest === 'string') {
    try { b = { formname: body.formTitle, submissionid: body.submissionID, ...JSON.parse(body.rawRequest) }; } catch { /* fall back to the plain fields */ }
  } else if (def.id === 'custom') {
    const named = String(req?.query.source ?? body?.source ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    if (named) { source = named; label = named.replace(/_/g, ' '); }
    if (b && typeof b === 'object' && 'source' in b) { b = { ...b }; delete b.source; }
  }
  const m = mapAnyPayload(source, b, label);
  const header = req?.headers['x-shopify-webhook-id'] ?? req?.headers['idempotency-key'];
  return { lead: m.lead, extId: (typeof header === 'string' && header ? header : m.extId)?.slice(0, 120) };
}

// ---------------------------------------------------------------------
const hits = new Map<string, { n: number; reset: number }>();
function underLimit(id: string, perMin = 240) {
  const now = Date.now(), h = hits.get(id);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  if (!h || h.reset < now) { hits.set(id, { n: 1, reset: now + 60_000 }); return true; }
  return ++h.n <= perMin;
}

function signedBy(secret: string, raw: Buffer | undefined, given: unknown): boolean {
  if (!raw || typeof given !== 'string') return false;
  const want = createHmac('sha256', secret).update(raw).digest();
  let got: Buffer;
  try { got = Buffer.from(given.replace(/^sha256=/, ''), 'base64'); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

const PROVIDER = 'lead_connectors';

@Controller('webhooks')
export class ConnectorWebhooksController {
  constructor(private readonly db: Db, private readonly intake: PortalIntake) {}

  @Post('in/:source/:key')
  @UseInterceptors(AnyFilesInterceptor({ limits: { files: 0, fieldSize: 300 * 1024 } }))
  post(@Param('source') source: string, @Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    return this.handle(source, key, req.body, req, res);
  }

  /** JustDial and some older systems deliver by GET. For everything else a
   *  GET is someone pasting the address into a browser to see if it's live. */
  @Get('in/:source/:key')
  async get(@Param('source') source: string, @Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    const def = findSource(source);
    const q = { ...req.query } as Record<string, unknown>; delete q.source;
    if (def?.get && Object.keys(q).length) return this.handle(source, key, req.query, req, res);
    const t = def && /^[\w-]{24,64}$/.test(key) ? (await this.db.appNoTenant('SELECT * FROM webhook_target($1, $2)', [PROVIDER, key])).rows[0] : null;
    if (!t) { res.status(404).json({ status: 'failed', message: 'Unknown address' }); return; }
    res.status(200).json({ status: 'ready', message: `This address is live. Send ${def!.name} leads here with POST.` });
  }

  private async handle(source: string, key: string, body: any, req: Request, res: Response) {
    const def = findSource(source);
    if (!def || !/^[\w-]{24,64}$/.test(key)) { res.status(404).json({ status: 'failed', message: 'Unknown address' }); return; }
    const t = (await this.db.appNoTenant('SELECT * FROM webhook_target($1, $2)', [PROVIDER, key])).rows[0];
    if (!t) { res.status(404).json({ status: 'failed', message: 'Unknown address' }); return; }
    if (!underLimit(key)) { res.status(429).json({ status: 'failed', message: 'Too many leads in one minute. Try again shortly.' }); return; }

    // Where the platform signs its deliveries and the client saved the secret, an unsigned post is refused.
    if (def.sign) {
      const secret = unseal(t.secrets_enc)[`${def.sign}_secret`];
      const given = req.headers[def.sign === 'shopify' ? 'x-shopify-hmac-sha256' : 'typeform-signature'];
      if (secret && !signedBy(secret, (req as any).rawBody, given)) { res.status(401).json({ status: 'failed', message: 'Signature check failed' }); return; }
    }

    const ok = (message: string, status = 'success') => {
      if (def.id === 'justdial' && status === 'success') res.status(200).type('text/plain').send('RECEIVED');
      else res.status(200).json({ status, message });
    };
    body = body && typeof body === 'object' ? body : {};
    if (body._hp) return ok('Lead added');                                                           // honeypot field of our own snippets

    const m = mapFor(def, body, req);
    const src = String(m.lead.source);
    if (m.extId && await this.seen(t.tenant_id, src, m.extId)) return ok('Already received');        // the platform retried a delivery we have

    const r = await this.intake.take(t, src, `push:${src}`, { ext_id: m.extId }, m.lead, 'connector', {
      provider: PROVIDER, off: 'Lead connectors are switched off for this workspace',
      unreadable: 'No mobile number found. A lead needs a name and a mobile number.',
      onFail: { text: JSON.stringify(body).slice(0, 4000) },
    });
    if (r.ok) return ok(r.duplicate ? 'Existing lead updated' : 'Lead added');
    if (def.reply === 'lenient') return ok(`Received, but not added: ${r.reason}`, 'held');
    res.status(422).json({ status: 'failed', message: r.reason });
  }

  private async seen(tenantId: string, source: string, extId: string) {
    return !!(await this.db.withTenant(tenantId, tx => tx.query(
      `SELECT 1 FROM webhook_events WHERE provider = $1 AND payload->>'portal' = $2 AND payload->>'ext_id' = $3 AND processed_at IS NOT NULL LIMIT 1`,
      [PROVIDER, source, extId]))).rowCount;
  }
}

/** Setup help for the client: the platform list, delivery log, review queue, test leads. */
@Controller('lead-connectors')
@UseGuards(TenantGuard)
@TenantRoles('owner', 'admin', 'sales_manager', 'crm_executive')
export class ConnectorSetupController {
  constructor(private readonly db: Db, private readonly intake: PortalIntake) {}

  @Get('sources')
  sources() { return SOURCES.map(({ reply, ...s }) => s); }

  @Get('deliveries')
  async deliveries(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT id, event_type, received_at, payload->>'portal' AS source, payload->>'summary' AS summary, payload->>'result' AS result,
              payload->>'reason' AS reason, left(payload->>'text', 600) AS excerpt, (processed_at IS NOT NULL) AS processed
       FROM webhook_events WHERE provider = $1 ORDER BY received_at DESC LIMIT 30`, [PROVIDER]))).rows;
  }

  /** Runs a sample lead through the same pipeline a real delivery uses. */
  @Post('test/:source') @HttpCode(200)
  async test(@Param('source') source: string, @Req() req: Request) {
    const def = findSource(source);
    if (!def) throw new NotFoundException('Unknown platform');
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot send test leads');
    const on = (await this.db.withTenant(req.tenant!.id, tx => tx.query(`SELECT enabled FROM integrations WHERE provider = $1`, [PROVIDER]))).rows[0];
    if (!on) throw new BadRequestException('Save this integration first');
    const lead = { ...mapFor(def, { name: `Test lead from ${def.name}`, phone: '9000012346', message: 'Test lead sent from HXG Connect settings' }).lead, tags: ['test'] };
    const r = await this.intake.take({ tenant_id: req.tenant!.id, enabled: on.enabled }, def.id, `test:${def.id}`, {}, lead, 'connector',
      { provider: PROVIDER, off: 'Lead connectors are switched off. Switch the integration on first.' });
    return r.ok ? { status: 'success', message: r.duplicate ? 'Existing lead updated' : 'Lead added' } : { status: 'failed', message: r.reason };
  }
}
