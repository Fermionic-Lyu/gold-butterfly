-- Expand to a 3 strategies × 3 models matrix so we can compare both axes.
-- Strategies (focus):  premium_seller (Theta), long_vol (Vega), directional_momentum (Delta).
-- Models:              Sonnet 4.6 (S), Gemini 3.1 Pro (G), GPT-5.4 (O).
--
-- Existing rows are renamed to the new slug convention; six new rows are
-- created via INSERT ... SELECT so the system_prompt + preset are reused
-- verbatim across the same strategy. Only the model differs within a row of
-- the matrix.

-- 1) Rename existing seeds to the matrix convention.
UPDATE agents SET slug = 'theta-sonnet', name = 'Theta · Sonnet'
  WHERE slug = 'theta-premium-collector';
UPDATE agents SET slug = 'vega-gemini', name = 'Vega · Gemini'
  WHERE slug = 'vega-volatility-hunter';
UPDATE agents SET slug = 'delta-gpt', name = 'Delta · GPT'
  WHERE slug = 'delta-trend-rider';

-- 2) Theta (premium_seller) — clone Sonnet to Gemini and GPT.
INSERT INTO agents (slug, name, focus, model, system_prompt, preset, watched_symbols, starting_capital, cash)
  SELECT 'theta-gemini', 'Theta · Gemini', focus, 'google/gemini-3.1-pro-preview',
         system_prompt, preset, watched_symbols, starting_capital, starting_capital
  FROM agents WHERE slug = 'theta-sonnet';

INSERT INTO agents (slug, name, focus, model, system_prompt, preset, watched_symbols, starting_capital, cash)
  SELECT 'theta-gpt', 'Theta · GPT', focus, 'openai/gpt-5.4',
         system_prompt, preset, watched_symbols, starting_capital, starting_capital
  FROM agents WHERE slug = 'theta-sonnet';

-- 3) Vega (long_vol) — clone Gemini to Sonnet and GPT.
INSERT INTO agents (slug, name, focus, model, system_prompt, preset, watched_symbols, starting_capital, cash)
  SELECT 'vega-sonnet', 'Vega · Sonnet', focus, 'anthropic/claude-sonnet-4.6',
         system_prompt, preset, watched_symbols, starting_capital, starting_capital
  FROM agents WHERE slug = 'vega-gemini';

INSERT INTO agents (slug, name, focus, model, system_prompt, preset, watched_symbols, starting_capital, cash)
  SELECT 'vega-gpt', 'Vega · GPT', focus, 'openai/gpt-5.4',
         system_prompt, preset, watched_symbols, starting_capital, starting_capital
  FROM agents WHERE slug = 'vega-gemini';

-- 4) Delta (directional_momentum) — clone GPT to Sonnet and Gemini.
INSERT INTO agents (slug, name, focus, model, system_prompt, preset, watched_symbols, starting_capital, cash)
  SELECT 'delta-sonnet', 'Delta · Sonnet', focus, 'anthropic/claude-sonnet-4.6',
         system_prompt, preset, watched_symbols, starting_capital, starting_capital
  FROM agents WHERE slug = 'delta-gpt';

INSERT INTO agents (slug, name, focus, model, system_prompt, preset, watched_symbols, starting_capital, cash)
  SELECT 'delta-gemini', 'Delta · Gemini', focus, 'google/gemini-3.1-pro-preview',
         system_prompt, preset, watched_symbols, starting_capital, starting_capital
  FROM agents WHERE slug = 'delta-gpt';
