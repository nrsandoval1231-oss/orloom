ALTER TABLE mission_delivery_effects DROP CONSTRAINT mission_delivery_effects_effect_check;
ALTER TABLE mission_delivery_effects ADD CONSTRAINT mission_delivery_effects_effect_check
  CHECK (effect IN ('upload','check','pull_request'));
