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
