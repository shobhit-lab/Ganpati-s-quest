-- =============================================================================
-- GLOBAL LEADERBOARD SETUP  (Supabase SQL editor)
-- Run this AFTER creating the results table from the comment in the game file
-- (public.niat_game_results, or whatever name you put in SUPABASE_CONFIG.table).
-- Replace the table name below if yours differs.
--
-- The game already INSERTS one row per completed run. The leaderboard only READS.
-- created_at (server clock, default now()) is the completion time used as the
-- final tie-breaker, so a client cannot fake it.
-- =============================================================================

-- 1) Let the public (anon) key read rows. Only name, campus, score, time and date are exposed to the UI.
create policy "anon can read leaderboard"
  on public.niat_game_results
  for select to anon
  using (true);

-- 2) Server-side validation: reject malformed or absurd rows even if someone bypasses the game UI.
alter table public.niat_game_results
  add constraint niat_chk_name   check (char_length(btrim(player_name)) between 1 and 40),
  add constraint niat_chk_campus check (char_length(btrim(campus)) between 1 and 160),
  add constraint niat_chk_score  check (total_score between 0 and 1000000),
  add constraint niat_chk_time   check (total_time between 0 and 86400);

-- 3) Index matching the official ranking order (score desc, time asc, completion asc).
create index if not exists niat_rank_idx
  on public.niat_game_results (total_score desc, total_time asc, created_at asc);

-- IMPORTANT (integrity): the game computes the score in the browser and posts it,
-- so a determined user can still submit a fake score inside the allowed range.
-- Constraints above only bound it. Fully tamper-proof scoring needs the score to be
-- computed or verified on a server (for example a Supabase Edge Function that receives
-- the run events and inserts the row with the service_role key, with the anon INSERT
-- policy removed). Never put a service_role key in the HTML.
