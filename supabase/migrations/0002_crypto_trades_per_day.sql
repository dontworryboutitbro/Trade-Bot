-- Separate daily trade cap for crypto (crypto trades 24/7 and is exempt from
-- the equity cap). Default 100/day for MOCK/PAPER; LIVE stays at 3 (crypto is
-- locked off for LIVE regardless).

alter table risk_profiles
  add column if not exists max_crypto_trades_per_day int not null default 100;

update risk_profiles set max_crypto_trades_per_day = 3 where environment = 'LIVE';
