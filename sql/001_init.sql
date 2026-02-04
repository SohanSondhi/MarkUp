-- 001_init.sql
-- Create runs table to persist orchestration runs

CREATE TABLE IF NOT EXISTS runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    state JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
);
