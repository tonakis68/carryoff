-- Stage 3: partner check-in / hand-back / refusal on real bookings, refunds, owner payouts.
-- Safe to run more than once.
alter table bookings add column if not exists payment_intent text;   -- Stripe payment, needed for refunds
alter table bookings add column if not exists photo_data text;       -- drop-off photo (small JPEG as text)
alter table bookings add column if not exists refunded_at timestamptz;
create index if not exists bookings_partner_day on bookings (partner_id, drop_date);
