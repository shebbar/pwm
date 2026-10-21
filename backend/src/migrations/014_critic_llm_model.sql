-- Which model the critic (runCritic, agent.ts) uses -- a separate choice
-- from is_active (the chat model), mirroring its exact shape: at most one
-- row can be the critic model, enforced at the DB level like is_active is.
-- NULL/none-set is a valid state (see llm/registry.ts's getCriticProvider,
-- which then falls back to any model other than the active one). The
-- "critic must differ from the active model unless only one model exists"
-- rule is NOT a DB constraint -- it depends on how many other rows exist
-- and which one is_active right now, so it's enforced in application code
-- (data.ts's activateCriticLlmModel) at write time, and again at read time
-- in getCriticProvider so it stays correct even if the active model
-- changes later and happens to collide with a previously-set critic pick.
ALTER TABLE llm_models
  ADD COLUMN IF NOT EXISTS is_critic BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS one_critic_llm_model ON llm_models (is_critic) WHERE is_critic;
