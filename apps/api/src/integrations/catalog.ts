import nodemailer from 'nodemailer';
import { config } from '../config';

export interface FieldDef {
  key: string; label: string; secret?: boolean; required?: boolean;
  options?: string[]; placeholder?: string; help?: string; pattern?: RegExp; patternHint?: string;
}
export type Verdict = { ok: boolean | null; detail: string };   // null = can't verify, saved as-is
type Verifier = (c: Record<string, string>, s: Record<string, string>) => Promise<Verdict>;

export interface ProviderDef {
  provider: string;
  scope: 'tenant' | 'platform';
  category: 'calling' | 'whatsapp' | 'payments' | 'email' | 'lead_sources';
  label: string;
  description: string;
  fields: FieldDef[];
  exclusive?: boolean;                      // only one enabled per category (calling)
  webhook?: 'whatsapp' | 'razorpay' | 'facebook' | 'google' | 'calls' | 'portal' | 'connector';
  docs?: string;
  verify: Verifier;
}

const E164 = /^\+[1-9]\d{7,14}$/;

// ---------- HTTP helpers --------------------------------------------
async function probe(url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const basic = (u: string, p: string) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });

function verdictFromStatus(name: string, status: number, okDetail: string): Verdict {
  if (status >= 200 && status < 300) return { ok: true, detail: okDetail };
  if (status === 401 || status === 403) return { ok: false, detail: `${name} rejected these credentials.` };
  if (status === 404) return { ok: false, detail: `${name} couldn't find that account. Check the account ID.` };
  return { ok: false, detail: `${name} answered with an unexpected error (${status}). Try again shortly.` };
}

async function guard(name: string, fn: () => Promise<Verdict>): Promise<Verdict> {
  try { return await fn(); }
  catch (e: any) {
    const why = e?.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
    return { ok: false, detail: `${name} ${why} from this server. Check its outbound internet access, then test again.` };
  }
}

const razorpayVerify: Verifier = (c, s) => guard('Razorpay', async () => {
  const r = await probe(`${config.providerBase.razorpay}/v1/payments?count=1`, basic(c.key_id, s.key_secret));
  const mode = c.key_id.startsWith('rzp_live_') ? 'live' : 'test';
  return verdictFromStatus('Razorpay', r.status, `Keys work. This is a ${mode}-mode account.`);
});

const razorpayFields: FieldDef[] = [
  { key: 'key_id', label: 'Key ID', required: true, placeholder: 'rzp_live_...', pattern: /^rzp_(test|live)_[A-Za-z0-9]+$/, patternHint: 'Starts with rzp_test_ or rzp_live_' },
  { key: 'key_secret', label: 'Key secret', secret: true, required: true },
  { key: 'webhook_secret', label: 'Webhook secret', secret: true, help: 'The secret you type when adding the webhook in Razorpay. Needed to trust payment confirmations.' },
];

// ---------- the catalog ---------------------------------------------
export const CATALOG: ProviderDef[] = [
  // ----- client: calling -----
  {
    provider: 'exotel', scope: 'tenant', category: 'calling', exclusive: true, webhook: 'calls', label: 'Exotel',
    description: 'Click-to-call, call recording and missed-call tracking through your Exotel account.',
    docs: 'https://my.exotel.com/apisettings/site#api-credentials',
    fields: [
      { key: 'account_sid', label: 'Account SID', required: true },
      { key: 'api_key', label: 'API key', required: true },
      { key: 'api_token', label: 'API token', secret: true, required: true },
      { key: 'subdomain', label: 'Region', required: true, options: ['api.exotel.com', 'api.in.exotel.com'], help: 'api.in.exotel.com for Mumbai-cluster accounts' },
      { key: 'caller_id', label: 'ExoPhone (caller ID)', required: true, placeholder: '+918047XXXXXX', pattern: E164, patternHint: 'International format, e.g. +918047112233' },
    ],
    verify: (c, s) => guard('Exotel', async () => {
      const base = config.providerBase.exotel ?? `https://${c.subdomain}`;
      const r = await probe(`${base}/v1/Accounts/${encodeURIComponent(c.account_sid)}.json`, basic(c.api_key, s.api_token));
      return verdictFromStatus('Exotel', r.status, 'Connected to your Exotel account.');
    }),
  },
  {
    provider: 'knowlarity', scope: 'tenant', category: 'calling', exclusive: true, webhook: 'calls', label: 'Knowlarity',
    description: 'Logs incoming, outgoing and missed Knowlarity calls on the right lead, and creates a lead from an unknown caller. Calls are placed from Knowlarity\'s own app; calling from inside HXG Connect needs Exotel or Twilio.',
    fields: [
      { key: 'sr_number', label: 'SuperReceptionist number', required: true, pattern: E164, patternHint: 'International format, e.g. +918061234567' },
      { key: 'caller_id', label: 'Caller ID', pattern: E164, patternHint: 'International format' },
      { key: 'api_key', label: 'API key (x-api-key)', secret: true, required: true },
      { key: 'authorization', label: 'Authorization token', secret: true, required: true },
    ],
    verify: async () => ({ ok: null, detail: 'Saved. Knowlarity has no safe test call, so the first click-to-call will confirm these keys.' }),
  },
  {
    provider: 'myoperator', scope: 'tenant', category: 'calling', exclusive: true, webhook: 'calls', label: 'MyOperator',
    description: 'Logs incoming, outgoing and missed MyOperator calls on the right lead, and creates a lead from an unknown caller. Calls are placed from MyOperator\'s own app; calling from inside HXG Connect needs Exotel or Twilio.',
    fields: [
      { key: 'company_id', label: 'Company ID', required: true },
      { key: 'caller_id', label: 'Caller ID', pattern: E164, patternHint: 'International format' },
      { key: 'api_token', label: 'API token', secret: true, required: true },
    ],
    verify: async () => ({ ok: null, detail: 'Saved. MyOperator has no safe test call, so the first click-to-call will confirm these keys.' }),
  },
  {
    provider: 'twilio', scope: 'tenant', category: 'calling', exclusive: true, webhook: 'calls', label: 'Twilio',
    description: 'For teams calling outside India, or already on Twilio.',
    fields: [
      { key: 'account_sid', label: 'Account SID', required: true, pattern: /^AC[0-9a-fA-F]{32}$/, patternHint: 'Starts with AC, 34 characters' },
      { key: 'auth_token', label: 'Auth token', secret: true, required: true },
      { key: 'from_number', label: 'Twilio number', required: true, pattern: E164, patternHint: 'International format' },
    ],
    verify: (c, s) => guard('Twilio', async () => {
      const r = await probe(`${config.providerBase.twilio}/2010-04-01/Accounts/${c.account_sid}.json`, basic(c.account_sid, s.auth_token));
      return verdictFromStatus('Twilio', r.status, `Connected${r.body?.friendly_name ? ` to ${r.body.friendly_name}` : ''}.`);
    }),
  },
  // ----- client: WhatsApp -----
  {
    provider: 'whatsapp_cloud', scope: 'tenant', category: 'whatsapp', label: 'WhatsApp Business (Meta Cloud API)',
    description: 'Send brochures and templates, and receive replies, from your own WhatsApp Business number.',
    docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
    webhook: 'whatsapp',
    fields: [
      { key: 'phone_number_id', label: 'Phone number ID', required: true, pattern: /^\d{10,20}$/, patternHint: 'Digits only, from WhatsApp > API setup' },
      { key: 'waba_id', label: 'WhatsApp Business Account ID', required: true, pattern: /^\d{10,20}$/, patternHint: 'Digits only' },
      { key: 'access_token', label: 'Permanent access token', secret: true, required: true, help: 'Create a System User token in Business Settings. Temporary tokens expire in 24 hours.' },
      { key: 'app_secret', label: 'App secret', secret: true, required: true, help: 'From your Meta app\'s basic settings. Used to trust incoming messages.' },
    ],
    verify: (c, s) => guard('Meta', async () => {
      const r = await probe(`${config.providerBase.graph}/v20.0/${c.phone_number_id}?fields=display_phone_number,verified_name`,
        { authorization: `Bearer ${s.access_token}` });
      if (r.status === 400 && r.body?.error?.code === 190) return { ok: false, detail: 'Meta says this access token has expired. Use a permanent System User token.' };
      return verdictFromStatus('Meta', r.status,
        r.body?.display_phone_number ? `Connected to ${r.body.display_phone_number}${r.body.verified_name ? ` (${r.body.verified_name})` : ''}.` : 'Connected.');
    }),
  },
  // ----- client: payments from buyers -----
  {
    provider: 'razorpay', scope: 'tenant', category: 'payments', label: 'Razorpay',
    description: 'Send payment links for booking amounts and milestones. Money goes straight to your account.',
    docs: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys',
    webhook: 'razorpay', fields: razorpayFields, verify: razorpayVerify,
  },
  // ----- client: lead sources -----
  {
    provider: 'property_portals', scope: 'tenant', category: 'lead_sources', label: 'Property portals (99acres, MagicBricks, Housing.com and more)',
    description: 'Portal enquiries become leads within seconds: forward the portals\' lead emails, or have a portal push leads directly.',
    webhook: 'portal', fields: [],
    verify: async () => ({ ok: null, detail: 'Saved. Forward one portal enquiry email, or ask a portal to send a test lead, then check Leads.' }),
  },
  {
    provider: 'lead_connectors', scope: 'tenant', category: 'lead_sources',
    label: 'Websites, marketplaces and other platforms (WordPress, Shopify, IndiaMART, JustDial, Zapier and more)',
    description: 'One address per platform. Leads from your website forms, online store, B2B listings and automation tools arrive within seconds, assigned by your rules.',
    webhook: 'connector',
    fields: [
      { key: 'shopify_secret', label: 'Shopify webhook signing secret', secret: true, help: 'Only if you connect Shopify. Shown in Shopify under Settings > Notifications > Webhooks. Once saved, posts that Shopify didn\'t sign are refused.' },
      { key: 'typeform_secret', label: 'Typeform webhook secret', secret: true, help: 'Only if you set a secret on your Typeform webhook.' },
    ],
    verify: async () => ({ ok: null, detail: 'Saved. Pick a platform below, follow its steps, then press Send test.' }),
  },
  {
    provider: 'facebook_leads', scope: 'tenant', category: 'lead_sources', label: 'Facebook and Instagram lead ads',
    description: 'Leads from your Facebook and Instagram lead forms arrive here within seconds, assigned by your rules.',
    docs: 'https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving',
    webhook: 'facebook',
    fields: [
      { key: 'page_id', label: 'Facebook Page ID', required: true, pattern: /^\d{5,20}$/, patternHint: 'Digits only, from your Page\'s About section' },
      { key: 'page_access_token', label: 'Page access token', secret: true, required: true, help: 'A long-lived Page token with leads_retrieval permission.' },
      { key: 'app_secret', label: 'App secret', secret: true, required: true, help: 'From your Meta app\'s basic settings. Used to trust incoming leads.' },
    ],
    verify: (c, s) => guard('Meta', async () => {
      const r = await probe(`${config.providerBase.graph}/v20.0/${c.page_id}?fields=name`, { authorization: `Bearer ${s.page_access_token}` });
      if (r.status === 400 && r.body?.error?.code === 190) return { ok: false, detail: 'Meta says this Page token has expired. Generate a long-lived one.' };
      return verdictFromStatus('Meta', r.status, r.body?.name ? `Connected to the Page "${r.body.name}".` : 'Connected.');
    }),
  },
  {
    provider: 'google_ads_leads', scope: 'tenant', category: 'lead_sources', label: 'Google Ads lead forms',
    description: 'Leads from lead form assets on your Google Ads campaigns, delivered by webhook.',
    docs: 'https://support.google.com/google-ads/answer/9423234',
    webhook: 'google', fields: [],
    verify: async () => ({ ok: null, detail: 'Saved. In Google Ads, paste the webhook URL and key into your lead form and press "Send test data" to confirm.' }),
  },
  // ----- platform: your billing and email -----
  {
    provider: 'razorpay_billing', scope: 'platform', category: 'payments', label: 'Razorpay (subscription billing)',
    description: 'The account HXG Connect uses to charge clients for their plan.',
    docs: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys',
    fields: razorpayFields, verify: razorpayVerify,
  },
  {
    provider: 'smtp', scope: 'platform', category: 'email', label: 'Email (SMTP)',
    description: 'Sends invitations and notifications. Works with Amazon SES, Zoho, Google Workspace, or any SMTP server.',
    fields: [
      { key: 'host', label: 'SMTP server', required: true, placeholder: 'email-smtp.ap-south-1.amazonaws.com' },
      { key: 'port', label: 'Port', required: true, options: ['587', '465', '25', '2525'] },
      { key: 'username', label: 'Username', required: true },
      { key: 'password', label: 'Password', secret: true, required: true },
      { key: 'from_email', label: 'Send from', required: true, placeholder: 'no-reply@yourcompany.com', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternHint: 'An email address' },
      { key: 'from_name', label: 'Sender name', placeholder: 'HXG Connect' },
    ],
    verify: (c, s) => guard('The SMTP server', async () => {
      const t = nodemailer.createTransport({
        host: c.host, port: Number(c.port), secure: c.port === '465',
        auth: { user: c.username, pass: s.password }, connectionTimeout: 8000, greetingTimeout: 8000,
      });
      try { await t.verify(); return { ok: true, detail: `Signed in to ${c.host}. Invitations will be emailed.` }; }
      catch (e: any) {
        if (e?.code === 'EAUTH') return { ok: false, detail: 'The SMTP server rejected the username or password.' };
        throw e;
      } finally { t.close(); }
    }),
  },
];

export const findProvider = (scope: 'tenant' | 'platform', provider: string) =>
  CATALOG.find(p => p.scope === scope && p.provider === provider);
