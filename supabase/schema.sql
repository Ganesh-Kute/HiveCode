-- Supabase Database Schema for Hivecode SaaS Billing
--
-- Idempotent: safe to run on a fresh project OR on one where an earlier version of this
-- file was already applied. Every statement is guarded, so re-running changes nothing.
--
-- Run in Supabase → SQL Editor, then set these in Vercel → Settings → Environment Variables:
--   SUPABASE_URL                 https://<project>.supabase.co
--   SUPABASE_SERVICE_ROLE_KEY    service_role key (server-side only, never in a client)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Organizations Table
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    stripe_customer_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- 2. Licenses Table
CREATE TABLE IF NOT EXISTS licenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    license_key VARCHAR(255) NOT NULL UNIQUE,
    max_committers INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'canceled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE
);

ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;

-- 3. Additions for self-serve Razorpay checkout.
-- org_id was NOT NULL, which forced an organizations row before any licence could exist.
-- Self-serve purchases have no organisation yet, so it is now optional and reserved for
-- team accounts later.
ALTER TABLE licenses ALTER COLUMN org_id DROP NOT NULL;

ALTER TABLE licenses ADD COLUMN IF NOT EXISTS email            VARCHAR(320);
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS plan             VARCHAR(50) NOT NULL DEFAULT 'pro';
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS subscription_id  VARCHAR(255);
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS payment_id       VARCHAR(255);
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS last_charged_at  TIMESTAMP WITH TIME ZONE;

-- Razorpay, alongside the original Stripe column so nothing existing breaks.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS razorpay_customer_id VARCHAR(255);

-- Webhook retries look up by subscription/payment id; licence recovery looks up by
-- payment id; support looks up by email.
CREATE INDEX IF NOT EXISTS licenses_subscription_id_idx ON licenses (subscription_id);
CREATE INDEX IF NOT EXISTS licenses_payment_id_idx      ON licenses (payment_id);
CREATE INDEX IF NOT EXISTS licenses_email_idx           ON licenses (lower(email));

CREATE OR REPLACE FUNCTION licenses_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS licenses_touch_updated_at ON licenses;
CREATE TRIGGER licenses_touch_updated_at
  BEFORE UPDATE ON licenses
  FOR EACH ROW EXECUTE FUNCTION licenses_touch_updated_at();

-- RLS is enabled on both tables with NO policies, so the anon and authenticated keys can
-- read nothing at all. Only the service_role key bypasses RLS. That is what stops anyone
-- holding your public anon key from listing every licence you have ever issued.

-- 3. Usage Periods — the meter behind the auto-lock.
--
-- Replaces seat counting as the enforcement unit. Seats were never really enforced: the
-- relay's committer set is keyed by FILE-room ("almost always one person", per its own
-- comment), so a 2-seat licence admitted two agents per file with no overall limit. It was
-- also per-process, so a restart forgot it.
--
-- `account` is a licence key when there is one, else the base room id. So a paid account
-- accumulates across every room and every relay restart, and an anonymous room accumulates
-- on its own.
--
-- One row per account per calendar month, UTC. The relay POSTs deltas and this row is the
-- authority; several relay instances can report into the same row safely because every
-- counter is additive and the two peaks are maxima.
CREATE TABLE IF NOT EXISTS usage_periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account      VARCHAR(200) NOT NULL,
    period       CHAR(7)      NOT NULL,          -- 'YYYY-MM', UTC
    writes       BIGINT       NOT NULL DEFAULT 0,
    write_bytes  BIGINT       NOT NULL DEFAULT 0,
    msgs         BIGINT       NOT NULL DEFAULT 0,
    bytes        BIGINT       NOT NULL DEFAULT 0,
    peak_rooms   INTEGER      NOT NULL DEFAULT 0,
    peak_agents  INTEGER      NOT NULL DEFAULT 0,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- The unique pair is what makes the relay's upsert (on_conflict=account,period) work. Without
-- it PostgREST cannot merge duplicates and every flush would insert a new row, so the total
-- would be spread across hundreds of rows and the limit check would always read a small one.
CREATE UNIQUE INDEX IF NOT EXISTS usage_periods_account_period_idx
    ON usage_periods (account, period);

-- Answers "who is over their limit this month" without a full scan.
CREATE INDEX IF NOT EXISTS usage_periods_period_idx ON usage_periods (period);

ALTER TABLE usage_periods ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS usage_periods_touch_updated_at ON usage_periods;
CREATE OR REPLACE FUNCTION usage_periods_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER usage_periods_touch_updated_at
  BEFORE UPDATE ON usage_periods
  FOR EACH ROW EXECUTE FUNCTION usage_periods_touch_updated_at();

-- Same posture as the licence tables: RLS on, no policies, so anon and authenticated keys
-- read nothing. Only service_role bypasses it, and that key lives only in Vercel.

-- 4. Grace and end-of-period access on licences.
--
-- Two money bugs this closes, both in the same handler:
--
--   subscription.cancelled set the licence to 'canceled' IMMEDIATELY. A customer who cancels
--   on the 3rd of the month loses access on the 3rd, having paid through the 30th. That is
--   the shape of a chargeback, not a cancellation.
--
--   subscription.halted set it to 'suspended' IMMEDIATELY. A halt is usually an expired
--   card -- the most common and most innocent failure there is -- and locking someone out of
--   their workspace on the first failed charge is a customer lost over a card they would have
--   replaced in a minute.
--
-- So the licence stays 'active' in both cases and carries a DEADLINE instead. validate.js
-- reads them and reports valid until the deadline passes, which is what "we paid through the
-- end of the month" and "we are chasing your card" actually mean.
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS grace_until  TIMESTAMP WITH TIME ZONE;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS access_until TIMESTAMP WITH TIME ZONE;
-- Why it is in one of those states, for support and for the dashboard banner.
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS lapse_reason VARCHAR(40);

-- Finds everyone whose grace or paid period has run out and still reads as active.
CREATE INDEX IF NOT EXISTS licenses_grace_until_idx  ON licenses (grace_until)  WHERE grace_until  IS NOT NULL;
CREATE INDEX IF NOT EXISTS licenses_access_until_idx ON licenses (access_until) WHERE access_until IS NOT NULL;
