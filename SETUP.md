# CarryOff stage 1: setup

What stage 1 adds: real partner login (emailed 6-digit code), real owner login (emailed code
plus an authenticator app), a working "Become a partner" form that emails the owner, and the
database and email code that later stages build on. Bookings and the partner dashboard still
show sample data until stage 2 and 3.

## 1. Database (Supabase)
1. Supabase → your project → **SQL Editor** → **New query**.
2. Paste all of `supabase/schema.sql`, click **Run**. Expect "Success".
3. New query again → paste `supabase/seed.sql` → **Run**.
4. Table Editor → `partners`: change the email of one row (for example `mosaic`) to your own
   email, in lowercase. That is how you test the partner login.

## 2. Keys (never paste these in chat, email or GitHub)
Supabase → Project Settings → **API Keys**: copy the **Project URL** and the **secret** key
(`sb_secret_...`). Do NOT use the `publishable` / `anon` key here.

Resend → **API Keys** → Create API key, name `carryoff`, permission **Sending access**,
domain `carryoff.eu`.

Make a random session secret: any 40+ random characters from your password manager.

## 3. Cloudflare settings
Workers & Pages → `carryoff` → **Settings** → **Variables and Secrets** → Add. Add each one for
BOTH Production and Preview. Use type **Secret** for the four marked (S).

| Name | Value |
|---|---|
| `SUPABASE_URL` | the Project URL |
| `SUPABASE_SECRET_KEY` (S) | the Supabase secret key |
| `RESEND_API_KEY` (S) | the Resend API key |
| `SESSION_SECRET` (S) | your random 40+ characters |
| `OWNER_EMAIL` | the email you log in as owner with |

Optional: `MAIL_FROM` (default `CarryOff <no-reply@carryoff.eu>`), `MAIL_REPLY_TO`
(default `hello@carryoff.eu`).

## 4. Try it
Open the preview address of the `stage-1` branch (Cloudflare → carryoff → Deployments).
* For partners → Dashboard → enter the email you set on a partner → code arrives → log in.
* For partners → Owner → your OWNER_EMAIL → code → first time you scan a QR code with Google
  Authenticator, enter its 6 digits. The QR code is shown only once.

## Tests
`node tests/run.mjs` runs 24 checks of the server code against fakes (no keys needed).

## Stage 2: payments (Stripe test mode first)

1. Supabase: SQL Editor, paste `supabase/stage2.sql`, Run (adds map position and address to partners, adds the 4 missing sample places).
2. Stripe (the CarryOff account, TEST mode): Developers -> API keys -> copy the Secret key (`sk_test_...`).
3. Stripe: Developers -> Webhooks -> Add endpoint. URL `https://carryoff.eu/api/stripe-webhook`. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`. Copy its Signing secret (`whsec_...`).
4. Cloudflare Pages -> carryoff -> Settings -> Variables and secrets (Production): add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, both type **Secret**. Retry the deployment.
5. Check `https://carryoff.eu/api/health` shows `"payments": true`.
6. Test card: 4242 4242 4242 4242, any future date, any CVC.
Going live later: swap in the live `sk_live_...` key and a live-mode webhook secret. Nothing else changes.

## Stage 3: partner and owner on real bookings

1. Run `supabase/stage3.sql` once in the Supabase SQL editor (adds payment reference, photo and refund columns).
2. Deploy (push to main). No new Cloudflare variables are needed.
3. Test: book with the Stripe test card, log in as the partner, scan or type the code, tag the bags, take a photo, hand back. Refusing bags refunds the customer in Stripe automatically.
Bookings paid before stage 3 have no stored payment reference: refund those by hand in Stripe if a partner refuses them.

## Stage 4: real partners

1. Run `supabase/stage4.sql` once in the Supabase SQL editor (adds hours, capacity, area and the approximate map pin to partners, and fills them in for the ten sample places).
2. Deploy. The map, list and booking page now load places from the database. Checkout now also enforces opening hours and capacity.
3. Add real partners in the site: For partners > Owner > Partners > Add a partner. The partner gets a welcome email with login steps.
4. When real partners are in, switch the samples off: Owner > Partners > Switch off (or run `update partners set active=false where email like '%@partner.invalid';`).
