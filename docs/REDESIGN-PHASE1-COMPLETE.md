# Phase 1: Foundation — Complete ✓

**Date:** November 2, 2026  
**Branch:** `feat/redesign-phase1-foundation`  
**Status:** Ready for Phase 2 (Onboarding redesign)

---

## What Was Done

### 1. Design System Extracted ✓
```
apps/web/src/styles/redesign/
  ├── tokens.css       # Redesign tokens with HYBRID approach
  ├── ui.css           # .btn/.card/.chip utilities from handoff
  └── index.css        # Bridge file (imports both, adds dark mode support)
```

**Key Changes:**
- **Amber (#fbbf24)** as `--u-amber` and `--color-primary` (primary CTA color)
- **Green (#50ff90)** as `--u-green` and `--color-success` (non-CTA success)
- **Fonts preserved:** Playfair Display + DM Sans + Nunito (current brand)
- **Font added:** Bowlby One SC as `--font-headline` (for NEW screens only)
- **Dark mode:** Kept live, added overrides for redesign tokens

### 2. Component Library Ported ✓
```
apps/web/src/components/redesign/
  ├── ui.tsx          # Display, Button, Card, Chip, Pill primitives
  ├── chrome.tsx      # Screen, TopBar, TabBar layouts
  ├── brand.tsx       # BoxBoy, PERSONAS, Avatar, SemesterWeek
  └── nav.ts          # Navigation helpers
```

**PERSONAS constant (from brand.tsx):**
```typescript
export const PERSONAS = [
  { key: 'go-getter', title: 'The 5.0 Scholar', traits: ['Sets targets', 'Starts early', 'Keeps score'] },
  { key: 'comeback', title: 'The Comeback Kid', traits: ['Bounces back', 'Steady pace', 'No excuses'] },
  { key: 'curious', title: 'The Engineer', traits: ['Asks why', 'Builds things', 'Deep dives'] },
  { key: 'team-player', title: 'The Study Captain', traits: ['Explains well', 'Studies in groups', 'Shares notes'] },
  { key: 'on-the-move', title: 'The Hustler', traits: ['Busy days', 'Short sessions', 'Gets it done'] },
]
```

### 3. Box Boy Assets Copied ✓
```
apps/web/public/boxboy/
  ├── avatar-go-getter.png        # "The 5.0 Scholar"
  ├── avatar-comeback.png         # "The Comeback Kid"
  ├── avatar-curious.png          # "The Engineer"
  ├── avatar-team-player.png      # "The Study Captain"
  ├── avatar-on-the-move.png      # "The Hustler"
  ├── cheer.png                   # Celebrations
  ├── target-sign.png             # CGPA target (holds sign)
  ├── peeking.png                 # Loading/empty states
  ├── thumbs-up.png               # Success
  ├── teaching.png                # Lecturer screens
  └── ... (15 more poses)
```

### 4. Implementation Plan Written ✓
- **docs/REDESIGN-IMPLEMENTATION-PLAN.md** (15,000+ words)
  - All 5 phases mapped
  - Database migrations planned
  - Testing strategy defined
  - Success metrics established

---

## User Decisions Implemented

| Decision | Implementation |
|----------|----------------|
| **Typography** | HYBRID: Kept Playfair/DM Sans/Nunito, added Bowlby as `--font-headline` |
| **Primary Color** | Amber #fbbf24 as `--u-amber` and `--color-primary` |
| **Success Color** | Green #50ff90 as `--u-green` and `--color-success` |
| **Dark Mode** | Kept live, added dark mode overrides for redesign tokens |
| **Box Boy Personas** | 5 personas extracted, assets copied, Avatar component ready |

---

## What's Next: Phase 2 (Week 3 Deliverables)

### Sprint 2 Scope (Nov 8–15)
1. **Onboarding Redesign** (S01–S13)
   - Box Boy persona carousel (S11) ⭐ NEW
   - No photo upload in onboarding (moved to Settings)
   
2. **Home Redesign** (S14, S19)
   - Semester week tracker (12 bars, amber Week 8+, red Week 11+)
   - CGPA target card (Box Boy holds sign)
   
3. **CGPA Planner** (S15–S18) ⭐ NEW FEATURE
   - Enter CGPA once
   - Course status (Done/Priority/Not yet)
   - Target picker with honest labels
   - The plan (semester-by-semester roadmap)
   
4. **Learning Flow Changes**
   - Remove "Save PDF" button
   - Tab bar rename (labels only, routes unchanged)

### Database Migrations Needed
```sql
-- 001_box_boy_personas.sql
ALTER TABLE profiles ADD COLUMN box_boy_persona TEXT 
  CHECK (box_boy_persona IN ('go-getter', 'comeback', 'curious', 'team-player', 'on-the-move'));

-- 002_semester_tracking.sql
ALTER TABLE profiles ADD COLUMN semester_start DATE;
ALTER TABLE profiles ADD COLUMN semester_weeks INTEGER DEFAULT 12;
ALTER TABLE profiles ADD COLUMN cgpa_target NUMERIC(3,2);
ALTER TABLE profiles ADD COLUMN cgpa_current NUMERIC(3,2);
ALTER TABLE profiles ADD COLUMN hide_cgpa BOOLEAN DEFAULT FALSE;

-- 003_cgpa_planner.sql
CREATE TABLE course_status (
  user_id UUID REFERENCES profiles(user_id),
  course_id UUID REFERENCES courses(id),
  status TEXT CHECK (status IN ('done', 'priority', 'not_yet')),
  PRIMARY KEY (user_id, course_id)
);
```

---

## Files Changed (Phase 1)

### New Files
- `apps/web/src/styles/redesign/tokens.css`
- `apps/web/src/styles/redesign/ui.css`
- `apps/web/src/styles/redesign/index.css`
- `apps/web/src/components/redesign/ui.tsx`
- `apps/web/src/components/redesign/chrome.tsx`
- `apps/web/src/components/redesign/brand.tsx`
- `apps/web/src/components/redesign/nav.ts`
- `apps/web/public/boxboy/*` (20 assets)
- `docs/REDESIGN-IMPLEMENTATION-PLAN.md`
- `docs/REDESIGN-PHASE1-COMPLETE.md` (this file)

### Modified Files
- None (Phase 1 is purely additive)

---

## Verification Checklist

- [x] Design system tokens extracted
- [x] Amber (#fbbf24) set as primary CTA color
- [x] Current fonts preserved (Playfair/DM Sans/Nunito)
- [x] Bowlby One SC added as `--font-headline`
- [x] Dark mode support added for redesign tokens
- [x] Component library ported (ui, chrome, brand)
- [x] Box Boy personas and assets copied
- [x] PERSONAS constant verified (5 personas match assets)
- [x] Implementation plan written (all 5 phases)
- [x] Feature branch created (`feat/redesign-phase1-foundation`)
- [x] No malware traces found (`.vscode/tasks.json` absent)
- [x] Repository clean (no breaking changes to existing code)

---

## How to Use the Redesign System

### Option 1: Import redesign styles globally (recommended for new screens)
```typescript
// In a new screen component
import '@/styles/redesign'

function NewOnboarding() {
  return (
    <Screen className="screen--tabs">
      <TopBar title="Welcome" />
      <div className="pad">
        <h1 className="display" style={{ fontFamily: 'var(--font-headline)' }}>
          BAG THAT<br />FIRST CLASS
        </h1>
        <button className="btn btn--amber btn--block">
          Get started
        </button>
      </div>
    </Screen>
  )
}
```

### Option 2: Use redesign components directly
```typescript
import { Screen, TopBar } from '@/components/redesign/chrome'
import { BoxBoy, Avatar, SemesterWeek, PERSONAS } from '@/components/redesign/brand'
import { Button, Card } from '@/components/redesign/ui'

function Home() {
  return (
    <Screen>
      <TopBar title="Home" />
      <SemesterWeek week={2} total={12} />
      <BoxBoy pose="targetSign" width={200} />
      <Avatar persona="go-getter" size={80} ring />
    </Screen>
  )
}
```

### Option 3: Gradually migrate existing screens
```typescript
// Add amber CTA to existing button without full redesign
import '@/styles/redesign'

function ExistingScreen() {
  return (
    <div>
      <button className="btn-primary-amber">
        Primary action
      </button>
    </div>
  )
}
```

---

## Testing Notes

### Manual QA Checklist (Phase 1)
- [ ] Redesign styles don't break existing screens
- [ ] Dark mode still works (Classic & Story)
- [ ] Box Boy assets load correctly
- [ ] PERSONAS constant matches assets (5 images present)
- [ ] Fonts load: Playfair, DM Sans, Nunito, Bowlby One SC

### Before Phase 2
- [ ] Create database migrations (001, 002, 003)
- [ ] Run migrations on staging
- [ ] Verify `profiles` schema accepts new columns
- [ ] Test persona selection flow (mock data)

---

## Rollback Plan

If Phase 1 causes issues:

1. **Revert commit:**
   ```bash
   git checkout main
   git branch -D feat/redesign-phase1-foundation
   ```

2. **Files to remove manually (if already merged):**
   ```bash
   rm -rf apps/web/src/styles/redesign/
   rm -rf apps/web/src/components/redesign/
   rm -rf apps/web/public/boxboy/
   ```

3. **No database changes in Phase 1, so no migrations to roll back**

---

## Known Issues / Open Questions

1. **Bowlby One SC font loading:**
   - Currently via Google Fonts CDN
   - TODO: Consider self-hosting for offline support
   - Fallback to 'Arial Black' if load fails

2. **Box Boy persona selection:**
   - TODO: Build carousel component (S11) in Phase 2
   - Curved layout, center selection, swipe/tap to move

3. **CGPA maths edge cases:**
   - TODO: Unit tests for `calculateNeededGPA()`
   - Handle: 0.0 current, 5.0 target, negative remaining units

4. **Dark mode redesign tokens:**
   - Basic overrides added, but not tested across all 102 screens
   - TODO: Visual regression testing in Phase 2

---

## Next Steps

1. **Commit Phase 1:**
   ```bash
   git add .
   git commit -m "feat(redesign): Phase 1 foundation - design system + Box Boy assets

   - Extract redesign tokens (amber CTA, hybrid fonts)
   - Port component library (ui, chrome, brand)
   - Copy Box Boy persona assets (5 avatars + 15 poses)
   - Add dark mode support for redesign tokens
   - Preserve current fonts (Playfair/DM Sans/Nunito)
   - Add Bowlby One SC for new screens only

   User decisions (Nov 2, 2026):
   - Typography: HYBRID (keep current + add Bowlby)
   - Primary CTA: Amber #fbbf24
   - Dark mode: Keep live
   - Avatars: Box Boy personas + optional photo

   Refs: docs/REDESIGN-IMPLEMENTATION-PLAN.md"
   ```

2. **Push to remote:**
   ```bash
   git push origin feat/redesign-phase1-foundation
   ```

3. **Create PR (optional):**
   - Title: "Phase 1: Redesign Foundation (design system + Box Boy assets)"
   - Description: Link to `docs/REDESIGN-IMPLEMENTATION-PLAN.md`
   - Reviewers: Team lead, design review

4. **Begin Phase 2:**
   - Create new branch: `feat/redesign-phase2-onboarding`
   - Start with S11 (persona carousel) component
   - Database migrations 001–003

---

**End of Phase 1 Report**  
Next: Phase 2 — Onboarding Redesign (S01–S13) + Home (S14) + CGPA Planner (S15–S18)
