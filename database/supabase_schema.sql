-- ==========================================
-- DeltaTrade Supabase DB Schema
-- Focus: Multi-account, Multi-strategy (Decay1)
-- ==========================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. ACCOUNTS TABLE
-- Stores multiple API credentials securely
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    api_key VARCHAR(255) NOT NULL,
    api_secret VARCHAR(255) NOT NULL,
    env VARCHAR(20) NOT NULL DEFAULT 'production', -- 'production' or 'testnet'
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. STRATEGIES TABLE
-- Defines the execution rules for each strategy (e.g. decay1)
CREATE TABLE IF NOT EXISTS strategies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE, -- e.g. 'decay1'
    description TEXT,
    underlying VARCHAR(10) NOT NULL DEFAULT 'BTC',
    entry_time_ist TIME NOT NULL DEFAULT '08:31:00',
    exit_time_ist TIME NOT NULL DEFAULT '12:29:00',
    strike_selection VARCHAR(50) NOT NULL DEFAULT 'otm6', -- 'otm6', 'atm', etc.
    sl_multiplier NUMERIC(5, 2) NOT NULL DEFAULT 1.40, -- 1.40 = 40% leg-wise stop loss
    underlying_target_pct NUMERIC(5, 4) NOT NULL DEFAULT 0.0075, -- 0.0075 = 0.75% spot move target
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert default Decay1 strategy details
INSERT INTO strategies (name, description, underlying, entry_time_ist, exit_time_ist, strike_selection, sl_multiplier, underlying_target_pct, is_active)
VALUES (
    'decay1',
    'Short Strangle premium decay strategy at 08:31 IST exiting at 12:29 IST using OTM6 Call/Put strikes, 40% leg SL, and 0.75% spot price target.',
    'BTC',
    '08:31:00',
    '12:29:00',
    'otm6',
    1.40,
    0.0075,
    true
) ON CONFLICT (name) DO UPDATE 
SET underlying = EXCLUDED.underlying,
    entry_time_ist = EXCLUDED.entry_time_ist,
    exit_time_ist = EXCLUDED.exit_time_ist,
    strike_selection = EXCLUDED.strike_selection,
    sl_multiplier = EXCLUDED.sl_multiplier,
    underlying_target_pct = EXCLUDED.underlying_target_pct;

-- 3. ACTIVE POSITIONS TABLE
-- Tracks live execution entries and monitoring targets
CREATE TABLE IF NOT EXISTS positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    strategy_name VARCHAR(100) NOT NULL,
    symbol VARCHAR(100) NOT NULL,
    side VARCHAR(10) NOT NULL, -- 'buy' or 'sell'
    product_id BIGINT NOT NULL,
    size INTEGER NOT NULL,
    entry_price NUMERIC(16, 6) NOT NULL,
    mark_price NUMERIC(16, 6),
    sl_price NUMERIC(16, 6),
    tp_price NUMERIC(16, 6),
    pnl NUMERIC(16, 6) DEFAULT 0.00,
    status VARCHAR(20) NOT NULL DEFAULT 'open', -- 'open' or 'closed'
    entry_order_id BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP WITH TIME ZONE
);

-- Indexing for fast position searches
CREATE INDEX IF NOT EXISTS idx_positions_account_status ON positions(account_id, status);

-- 4. SYSTEM & TRADE LOGS TABLE
-- Used to stream execution updates directly to the dashboard
CREATE TABLE IF NOT EXISTS trade_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_name VARCHAR(100),
    strategy_name VARCHAR(100),
    message TEXT NOT NULL,
    log_level VARCHAR(20) NOT NULL DEFAULT 'INFO', -- 'INFO', 'TRADE', 'ERROR'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexing logs for sorted dashboard streaming
CREATE INDEX IF NOT EXISTS idx_trade_logs_created_at ON trade_logs(created_at DESC);

-- 5. DAILY PNL HISTORY TABLE
-- Tracks metrics across accounts to feed performance graphs
CREATE TABLE IF NOT EXISTS pnl_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    realized_pnl NUMERIC(16, 6) NOT NULL DEFAULT 0.00,
    total_fees NUMERIC(16, 6) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, date)
);

-- Automatically update timestamps trigger function
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add timestamp triggers
CREATE TRIGGER update_accounts_modtime BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE PROCEDURE update_modified_column();
CREATE TRIGGER update_strategies_modtime BEFORE UPDATE ON strategies FOR EACH ROW EXECUTE PROCEDURE update_modified_column();
