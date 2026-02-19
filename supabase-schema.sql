-- Cybake Importer - Supabase Schema
-- Run this in the Supabase SQL Editor to set up the database

-- Import logs table
CREATE TABLE IF NOT EXISTS import_logs (
  id BIGSERIAL PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  customer_name TEXT,
  customer_email TEXT,
  delivery_date DATE,
  order_type TEXT,
  line_items_count INTEGER DEFAULT 0,
  order_total NUMERIC(10,2),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'pending')),
  cybake_import_id INTEGER,
  http_status INTEGER,
  error_message TEXT,
  payload_sent JSONB,
  cybake_response JSONB,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX idx_import_logs_status ON import_logs(status);
CREATE INDEX idx_import_logs_created_at ON import_logs(created_at DESC);
CREATE INDEX idx_import_logs_order_number ON import_logs(order_number);
CREATE INDEX idx_import_logs_shopify_order_id ON import_logs(shopify_order_id);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON import_logs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Enable Row Level Security
ALTER TABLE import_logs ENABLE ROW LEVEL SECURITY;

-- Allow the service role full access (used by Netlify functions)
CREATE POLICY "Service role full access"
  ON import_logs
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Allow anonymous read access (used by the dashboard)
CREATE POLICY "Anon read access"
  ON import_logs
  FOR SELECT
  TO anon
  USING (true);
