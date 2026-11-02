-- Add Box Boy persona selection (Phase 2: Onboarding redesign)
-- Students pick from 5 personas: go-getter, comeback, curious, team-player, on-the-move
-- Replaces generic avatar selection with personality-based onboarding

ALTER TABLE profiles ADD COLUMN box_boy_persona TEXT 
  CHECK (box_boy_persona IN ('go-getter', 'comeback', 'curious', 'team-player', 'on-the-move'));

-- Index for persona-based queries (future: persona-specific tips, stats)
CREATE INDEX idx_profiles_persona ON profiles(box_boy_persona) WHERE box_boy_persona IS NOT NULL;
