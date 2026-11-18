# Unify Learn Redesign Implementation Plan

**Version:** v1.26.15 → v2.0.0  
**Date:** November 2, 2026  
**Documents:** Developer Handoff (Oct 27), Why Each Screen Works (Nov 2), 102 screens in unify-learn-ui.zip

---

## User Decisions Summary

| Decision | Your Choice | Implementation Notes |
|----------|-------------|---------------------|
| **Typography & Color** | Keep fonts, adopt **amber #fbbf24** | Preserve Playfair/DM Sans/Nunito, change only --color-primary |
| **Dark Mode** | Keep it live | Maintain both Classic & Story dark variants |
| **Student Avatars** | Box Boy default, photo optional | 5 personas in onboarding, photo upload in Settings only |
| **CGPA Planner** | Build it ✓ | S15–S18, 4 screens, day-one value |
| **Semester Week Tracker** | Add it ✓ | Home hero, 12 bars, amber Week 8+, red Week 11+ |
| **HOC Role** | Build Week 3–4 ✓ | Bridge to lecturer materials, attendance scanning |
| **Attendance** | After Week 8 ✓ | QR system, crypto-signed passes, offline-capable |
| **Online Classes** | Build it ✓ | Wrap Meet/Zoom, 2-of-3 check-ins, room assignment |
| **Lecturer Redesign** | Full redesign Week 8 ✓ | Send★/Post★/Review★/Report★ (L01–L20) |
| **Tab Structure** | Hybrid: rename tabs, keep routing | Dashboard→Home, Learn→Timetable, Explore→Class, Profile→Me |
| **Save PDF** | Remove it ✓ | Offline-only, enforce retention strategy |
| **Lecture 1/2/3** | Flatten to week-level | Remove ?c= switcher, merge into week-level progress |
| **Box Boy Personas** | Build the system ✓ | 5 personas with traits, curved carousel (S11) |
| **Retention Strategy** | Commit: remove PDF export | Notes stay in app, no window.print() escape hatch |

---

## Implementation Phases

### **Phase 1: Foundation (Week 1–2, Now → Nov 15)**

#### 1.1 Design System Migration
**Goal:** Integrate handoff design tokens while preserving current fonts

```bash
apps/web/src/styles/
  tokens-redesign.css     # NEW: Extract from unify-learn-ui, merge with current
  ui-redesign.css         # NEW: .btn/.card/.chip utilities from handoff
```

**Token Strategy:**
- **Keep:** `--font-display: Playfair Display`, `--font-body: DM Sans`, `--fd: Nunito`
- **Change:** `--color-primary: #fbbf24` (amber, was emerald #10b981)
- **Add:** Bowlby One SC as `--font-headline` for new screens only
- **Keep:** `--u-green: #50ff90` as success/non-CTA accent
- **Keep:** Both Classic & Story designs, both dark modes

**Merge Plan:**
1. Extract `docs/unify-learn-ui/unify-learn-ui/src/styles/tokens.css` → `apps/web/src/styles/tokens-redesign.css`
2. Update amber: `--u-amber: #fbbf24` (this becomes new --color-primary)
3. Add font fallback: `--font-display: 'Bowlby One SC', 'Playfair Display', Georgia, serif;`
4. Import both in `index.css`: existing tokens first, redesign tokens override selectively

#### 1.2 Component Library Port
**Source:** `docs/unify-learn-ui/unify-learn-ui/src/components/`

```bash
apps/web/src/components/
  redesign/
    ui.tsx              # Display, Button, Card, Chip, Pill (new primitives)
    chrome.tsx          # Screen, TopBar, TabBar (new layouts)
    brand.tsx           # BoxBoy, PERSONAS, Avatar, SemesterWeek
```

**Strategy:** Keep existing components untouched, new screens import from `redesign/`

#### 1.3 Box Boy Assets
```bash
public/boxboy/
  persona-scholar.png       # The 5.0 Scholar
  persona-hustler.png       # The Side Hustle King
  persona-balanced.png      # The Balanced Approach
  persona-nightowl.png      # The Night Owl
  persona-sociallearner.png # The Social Learner
```

**Action Items:**
- [ ] Copy `docs/unify-learn-ui/unify-learn-ui/public/boxboy/` → `apps/web/public/boxboy/`
- [ ] Extract PERSONAS constant from `brand.tsx`
- [ ] Create persona carousel component (S11 reference)

---

### **Phase 2: Week 3 Deliverables (Nov 8–15)**

#### 2.1 Onboarding Redesign (S01–S13)
**Screens:**
- S01: Splash with swappable sponsor footer
- S02–S05: 4 slides → Google/email signup
- S06: Department picker (single screen, dropdowns)
- S07: Course picker (PRIORITY chip for other levels)
- S08: Goal picker (5 options: improve/habit/understand/study-with-others/balance)
- S09: Study rhythm (morning/night owl, focus length)
- **S11: Box Boy persona carousel** ⭐ NEW
  - Curved layout, selected center, neighbors fade
  - Persona name + tagline + 3 traits
  - Swipe or tap to move
- S12: Push permission
- S13: "Bag that first class"

**Key Changes:**
- **No photo upload in onboarding** (moved to Settings)
- **Persona selection required** before profile creation
- Route: `/onboarding` → new flow, old onboarding deprecated

**Implementation:**
```typescript
// src/routes/onboarding/PersonaSelect.tsx
import { PERSONAS, BoxBoy, PersonaCarousel } from '@/components/redesign/brand'

// Store selected persona in profile.box_boy_persona
// Schema: ALTER TABLE profiles ADD COLUMN box_boy_persona TEXT
```

#### 2.2 Home Redesign (S14, S19)
**Current:** Dashboard with streak, XP, upcoming classes  
**New:** Home with semester progress + CGPA target

**Components:**
- Greeting + department pill
- **Semester week tracker** (12 bars, Week 8+ amber, Week 11+ red)
- **CGPA target card** (Box Boy holds sign)
  - Before set: "Set my target" amber button → CGPA Planner
  - After set: editable, "Hide numbers" toggle
- Cards: Continue → Today's revision → Next class → My courses

**Schema Changes:**
```sql
-- Migration: Add semester tracking
ALTER TABLE profiles ADD COLUMN semester_start DATE;
ALTER TABLE profiles ADD COLUMN semester_weeks INTEGER DEFAULT 12;
ALTER TABLE profiles ADD COLUMN cgpa_target NUMERIC(3,2);
ALTER TABLE profiles ADD COLUMN cgpa_current NUMERIC(3,2);
ALTER TABLE profiles ADD COLUMN hide_cgpa BOOLEAN DEFAULT FALSE;
```

#### 2.3 CGPA Planner (S15–S18) ⭐ NEW FEATURE
**4 screens, day-one retention hook:**

**S15: Enter CGPA once**
- "What's your current CGPA?" (not per-course grades)
- Single input, 0.00–5.00 validation
- "Haven't started yet?" → Skip option

**S16: Course status**
- List all user's courses from onboarding
- Three states: Done ✓ / Priority (compulsory, pre-ticked) / Not yet
- Units calculated from ticks
- Bottom: "32 units done · 48 remaining"

**S17: Target picker with honest labels**
- Slider 2.5–5.0
- **Maths:** `(T × total_units − current_CGPA × units_done) ÷ remaining_units` = GPA needed per semester
- **Labels:**
  - `needed > 5.0`: "Out of reach" (grey)
  - `needed 4.5–5.0`: "Very difficult" (amber)
  - `needed 3.5–4.4`: "Stretch goal" (green)
  - `needed < 3.5`: "Achievable" (green)
- Show semester GPA needed: "You'd need a 4.2 GPA each semester"

**S18: The plan**
- Roadmap: "Semester 1: 4.2 · Semester 2: 4.2 · Semester 3: 4.2"
- What-if: "If you get 3.8 this semester, you'd need 4.4 after"
- "Adjust my plan" → back to S17
- "Lock it in" → save to profile

**Implementation:**
```typescript
// src/routes/cgpa-planner/
//   Enter.tsx, CourseStatus.tsx, TargetPicker.tsx, Plan.tsx
// src/lib/cgpa.ts
export function calculateNeededGPA(
  target: number,
  current: number,
  unitsDone: number,
  unitsRemaining: number
): number {
  return (target * (unitsDone + unitsRemaining) - current * unitsDone) / unitsRemaining
}
```

#### 2.4 Learning Flow Changes
**Remove Save PDF:**
- Delete "Save PDF" button from notes reader
- Remove `window.print()` handler
- Keep "Save for offline" (existing SW cache)

**Tab Bar Rename:**
```typescript
// src/components/TabBar.tsx (or wherever tabs are defined)
const TABS = [
  { route: '/dashboard', label: 'Home', icon: Home },      // was "Dashboard"
  { route: '/learn', label: 'Timetable', icon: Calendar },  // was "Learn"
  { route: '/explore', label: 'Class', icon: Users },       // was "Explore"
  { route: '/profile', label: 'Me', icon: User },           // was "Profile"
]
```

**Routes stay unchanged, only labels change**

---

### **Phase 3: Week 4 Deliverables (Nov 16–22)**

#### 3.1 HOC Tools (S54–S56) ⭐ NEW ROLE
**NEW database role: `head_of_class`**

**Schema:**
```sql
-- profiles table already has user_role (student/contributor/lecturer/admin)
-- Add HOC as a student flag, not a separate role
ALTER TABLE profiles ADD COLUMN is_hoc BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN hoc_approved_at TIMESTAMP;
ALTER TABLE profiles ADD COLUMN hoc_approved_by UUID REFERENCES profiles(user_id);

-- HOC-created content
CREATE TABLE hoc_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES profiles(user_id) NOT NULL,
  department_id UUID REFERENCES departments(id) NOT NULL,
  level INTEGER NOT NULL,
  type TEXT NOT NULL, -- 'announcement' | 'tip' | 'question'
  title TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**S54: Post to class**
- Type picker: Announcement / Study tip / Question
- Department + level select
- Title (optional for tips)
- Content (rich text, 2000 chars)
- Preview → Post

**S55: Edit timetable**
- Same UI as current class editor
- Plus: "This clashes with another class" warning
- "Unconfirmed classes" filter (moved/TBA)

**S56: Contributors list**
- Who writes what (read-only, admin-managed)
- **Upload lecturer materials** button
  - Opens file picker (.pdf/.pptx/.docx)
  - Tags: course, week, type (slides/notes/past-paper)
  - Uploads to Supabase Storage `lecturer-materials/`
  - Creates row in `materials` table

**HOC Request Flow:**
- Settings → "Become class rep"
- One-tap request (no form, user_id is enough)
- Admin sees pending HOC requests in admin panel
- Admin approves → `is_hoc = TRUE`, `hoc_approved_at = NOW()`

#### 3.2 Contributor Front-End Redesign (C01–C06)
**Current:** Single Studio page with 3 tabs  
**New:** 6 screens matching handoff

- C01: Dashboard (pipeline board: Materials → Writing → Submitted → Live)
- C02: Compose (outline picker → section editor)
- C03: Review (side-by-side: outline + preview)
- C04: Submit (checklist, single button)
- C05: Live content (published weeks, analytics)
- C06: Me (contributor profile, portfolio)

**Implementation:**
- Port from `docs/unify-learn-ui/unify-learn-ui/src/screens/contributor/`
- Keep existing Studio API routes (`/api/studio/*`)
- Redesign UI only, backend unchanged

#### 3.3 Admin Panel Redesign
**Current:** Single admin page (`/admin`)  
**New:** Sidebar layout, 7 sections

```bash
/admin
  /dashboard          # Overview, pending HOC requests
  /content-pipeline   # Materials → Writing → Submitted → Live (board view)
  /contributors       # Manage writers, assign courses
  /hoc-requests       # Approve/deny class rep requests
  /lecturers          # Pending lecturer onboarding (Phase 4)
  /system             # Settings, cache clear, version
  /analytics          # Student engagement, completion rates
```

**Key Addition: HOC Request Approvals**
```typescript
// /admin/hoc-requests
// List all pending requests (is_hoc = FALSE, no hoc_approved_at)
// Show: student name, department, level, courses enrolled, request date
// Actions: Approve (sets is_hoc = TRUE), Deny (soft delete or flag)
```

---

### **Phase 4: Week 5–8 Deliverables (Nov 23 – Dec 20)**

#### 4.1 Flatten Lecture 1/2/3 Structure ⚠️ BREAKING CHANGE
**Current:** Lecture 1/2/3 within weeks, `?c=` switcher, per-lecture progress  
**New:** One topic per class, week-level progress

**Migration:**
```sql
-- 1. Merge lecture-keyed progress into week-level
-- Strategy: Take the LATEST lecture's progress as the week's progress
UPDATE weeks w
SET 
  is_studied = (
    SELECT is_studied FROM lectures l 
    WHERE l.week_id = w.id 
    ORDER BY lecture_number DESC LIMIT 1
  ),
  studied_at = (
    SELECT studied_at FROM lectures l 
    WHERE l.week_id = w.id 
    ORDER BY lecture_number DESC LIMIT 1
  )
WHERE EXISTS (SELECT 1 FROM lectures WHERE week_id = w.id);

-- 2. Drop lectures table (or archive it)
-- Note: Keep lecture content in weeks.content as JSON blocks
-- Structure: [{ type: 'topic', title: '...', content: '...' }, ...]

-- 3. Remove ?c= query param from all routes
-- Find: grep -r "c=" apps/web/src/routes/
```

**UI Changes:**
- Remove lecture switcher from notes reader
- Week page shows all topics in one scroll
- Progress: "Week 3 · 6 topics" (not "Lecture 2 of 3")

#### 4.2 Timetable & Class (S37–S43)
**Timetable (S37–S38):**
- Week view default (7 days, current week highlighted)
- Day view toggle
- **Neutral colors** (color = status only, not department)
  - Default: white card, black text
  - Red border + chip: cancelled
  - Amber dashed border: moved/not confirmed
  - Grey "PRIORITY" chip: elective from another level
- Tap class → S39 (lecturer check-in)

**Class Feed (S42–S43):**
- Announcement-only (no student posts yet)
- HOC posts appear here
- Lecturer posts appear here (Phase 4)
- Filter: All / Announcements / Tips / Questions

#### 4.3 Lecturer Side Full Redesign (L01–L20) ⭐ MAJOR
**20 screens, Faculty proposal deliverable**

**Onboarding (L01–L06):**
- L01: Welcome (SEND IT ONCE principle)
- L02: Department + courses taught
- L03: Timetable setup
- L04: Class list upload (photo OCR → names/matric)
- L05: Attendance preferences
- L06: "You're all set"

**Home (L07–L08):**
- L07: One main button
  - Before class: "Confirm class" (marks class as happening)
  - During class: "Open scan" (attendance)
  - After class: "Post materials" or "Review week"
- L08: Quick stats (attendance avg, materials sent, posts this week)

**Timetable (L09):**
- Two tabs: "Class timetable" (students' view) + "My own" (personal schedule)
- Can't edit class timetable (HOC does that)

**Course Page (L10–L12):**
- L10: 3 tabs: Weeks / Report / Attendance
- Department switcher if lecturer teaches multiple
- L11: Weeks tab (curriculum, what's covered when)
- L12: Report tab (counts only, never names)
  - "Week 3: 78% studied, 12% skipped, 10% not reached"
  - "Quiz 3: 82% average, 3 attempts average"
  - NO STUDENT NAMES (privacy principle #6)

**Actions (L13–L15):**
- **L13: Review a week ★**
  - Read the contributor-written content
  - Flag errors, suggest improvements
  - Submit review → contributor sees it
- **L14: Send materials ★**
  - Upload slides/notes/past papers
  - Tag: course, week, type
  - Send to all students in that course
- **L15: Post to students ★**
  - Type: Announcement / Tip / Reminder
  - Target: One class / all classes you teach / specific level
  - Rich text, 2000 chars
  - Post → appears in students' Class feed

**Attendance (L16):**
- L16: Attendance list (counts + percentages per student)
- Filter: All / <75% / <50% (at-risk)
- Export CSV (for Faculty reporting)

**Me (L17):**
- Profile, courses taught, logout

#### 4.4 Me & Settings (S45–S53)
**Me (S45–S46):**
- S45: Student version
  - Box Boy avatar, name, department
  - Streak (if you keep it)
  - Saved courses
  - Notifications
- S46: HOC version (adds "Class rep tools" card)

**Settings (S47–S53):**
- S47: Main menu
- S48: **Edit profile** (name, Box Boy persona, **photo upload optional**)
- S49: Notifications (times, quiet hours)
- S50: Attendance setup (full name + matric, required before first scan)
- S51: About (version, privacy, terms)
- S52: Help
- S53: Danger zone (delete account)

**Photo Upload Implementation:**
- Only in Settings, not onboarding
- Downscale to 256px JPEG (keep existing logic from v1.26.15)
- Storage: `avatars/{user_id}.jpg`
- profile.avatar_url overrides profile.box_boy_persona if set

---

### **Phase 5: After Week 8 (Dec 21+)**

#### 5.1 Attendance System (S57–S63) ⭐ CRYPTOGRAPHIC
**Security model:** Server-signed passes, device keypairs, offline-capable

**S57: Attendance setup**
- Full name + matric number (required before first scan)
- One-time setup, stored in profile

**S59: Pass (the QR code)**
- Generated on-device, rotates every 30s
- **Payload:**
  ```json
  {
    "student_id": "uuid",
    "name": "Full Name",
    "matric": "123456",
    "courses": ["uuid1", "uuid2"],
    "valid_until": 1699999999,
    "device_pubkey": "base64_ed25519_pubkey",
    "signature": "server_signature_over_above"
  }
  ```
- **Crypto:**
  - Server signs with Ed25519 or ECDSA P-256
  - Device generates keypair (Web Crypto API, non-extractable)
  - Stored in IndexedDB
  - Pass rotates by regenerating `valid_until`, re-signing
- **Offline:** Pass works offline if generated while online

**S61: Scanner (HOC/lecturer)**
- Camera opens (Web QR scanner or native Capacitor plugin)
- Validates signature against server's public key (offline-capable)
- Checks `valid_until` > now
- Checks `courses` includes current class
- Marks attendance in local queue (uploads when online)

**S62: Confirm lecturer**
- After scan, student sees lecturer's name + photo
- "Yes, this is my lecturer" / "Wrong person"
- Prevents impostor scanning

**S63: My attendance**
- List: Course → percentage
- Gentle nudge under 75%: "You've missed 4 classes in MEE352"
- No shame, no public leaderboard

**Schema:**
```sql
CREATE TABLE attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES profiles(user_id) NOT NULL,
  class_id UUID REFERENCES classes(id) NOT NULL,
  scanned_by UUID REFERENCES profiles(user_id) NOT NULL, -- HOC or lecturer
  scanned_at TIMESTAMP DEFAULT NOW(),
  scan_location TEXT, -- lat,lng if available
  verified BOOLEAN DEFAULT FALSE -- student confirmed lecturer
);

CREATE TABLE device_keys (
  user_id UUID REFERENCES profiles(user_id) PRIMARY KEY,
  device_pubkey TEXT NOT NULL, -- base64 Ed25519 or P-256 public key
  registered_at TIMESTAMP DEFAULT NOW()
);
```

**Implementation:**
```typescript
// src/lib/attendance.ts
import { generateKeyPair, sign, verify } from '@/lib/crypto'

export async function generatePass(studentId: string): Promise<string> {
  const { publicKey, privateKey } = await getOrCreateDeviceKeys()
  const payload = {
    student_id: studentId,
    // ... rest of payload
    valid_until: Date.now() + 30_000, // 30s from now
    device_pubkey: await exportKey(publicKey)
  }
  const signature = await serverSign(payload) // Server endpoint
  return JSON.stringify({ ...payload, signature })
}

export async function validatePass(qrData: string): Promise<boolean> {
  const pass = JSON.parse(qrData)
  if (pass.valid_until < Date.now()) return false
  return await verifySignature(pass, SERVER_PUBLIC_KEY)
}
```

#### 5.2 Online Classes (S64–S70, L18–L20)
**Wrapper around Meet/Zoom, not a replacement**

**S64–S65: Join through Unify**
- 5 min before class → "Join now" button appears
- Opens in-app browser (Capacitor) or new tab (web)
- **Why wrapper:** Attendance check-ins

**S66–S67: 2 of 3 check-ins = present**
- Check-in 1: Joined on time (first 10 min)
- Check-in 2: Mid-class prompt (random 30s window, 20–40 min in)
- Check-in 3: Stayed to end (last 10 min)
- **2 of 3 = present** (allows bathroom break, connection drop)

**S68: Lecturer-initiated break**
- Lecturer pauses check-ins for 10 min
- Students see "Break time" banner

**S69: Lost connection report**
- "I lost connection" button
- Timestamp + reason logged
- Lecturer sees flagged attendance, can manually mark present

**S70: Class done summary**
- "You were present for 2 of 3 check-ins"
- Attendance marked automatically

**Lecturer Controls (L18–L20):**
- L18: Room assignment (for 100+ person classes, breakout groups)
- L19: Check-in management (pause, resume, manual overrides)
- L20: Post-class review (who checked in, who reported issues)

**Schema:**
```sql
CREATE TABLE online_class_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID REFERENCES classes(id) NOT NULL,
  meet_link TEXT, -- or zoom_link
  started_at TIMESTAMP,
  ended_at TIMESTAMP
);

CREATE TABLE online_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES online_class_sessions(id) NOT NULL,
  student_id UUID REFERENCES profiles(user_id) NOT NULL,
  checkin_1 TIMESTAMP, -- joined on time
  checkin_2 TIMESTAMP, -- mid-class
  checkin_3 TIMESTAMP, -- stayed to end
  marked_present BOOLEAN GENERATED ALWAYS AS (
    (checkin_1 IS NOT NULL)::int + 
    (checkin_2 IS NOT NULL)::int + 
    (checkin_3 IS NOT NULL)::int >= 2
  ) STORED
);
```

#### 5.3 Verified Class Lists (Pending Design)
**Status:** Handoff says "still being designed," not ready for Week 8

**Proposed Flow:**
1. HOC uploads photo of official class list
2. OCR extracts names + matric numbers (server-side, Tesseract or cloud API)
3. Students claim via school email (`@st.lasu.edu.ng` Google sign-in)
4. Fallback: Manual HOC approval if email not available

**Not building this until design is finalized.**

---

## File Structure After Redesign

```
apps/web/src/
  components/
    redesign/              # NEW: Handoff components
      ui.tsx               # Display, Button, Card, Chip, Pill
      chrome.tsx           # Screen, TopBar, TabBar
      brand.tsx            # BoxBoy, PERSONAS, SemesterWeek
    ui/                    # KEEP: Existing shadcn primitives
    TabBar.tsx             # EDIT: Rename tab labels
  routes/
    onboarding/            # REDESIGN: S01–S13 with persona carousel
      PersonaSelect.tsx    # NEW: S11
    home/                  # REDESIGN: Dashboard → Home, add semester tracker
      SemesterWeek.tsx     # NEW: 12-bar progress
      CGPATarget.tsx       # NEW: Card with Box Boy + target
    cgpa-planner/          # NEW: S15–S18
      Enter.tsx
      CourseStatus.tsx
      TargetPicker.tsx
      Plan.tsx
    timetable/             # REDESIGN: S37–S38, neutral colors
    class/                 # REDESIGN: S42–S43, feed
    hoc/                   # NEW: S54–S56
      PostToClass.tsx
      EditTimetable.tsx
      UploadMaterials.tsx
    lecturer/              # REDESIGN: L01–L20
      onboarding/
      home/
      course/
      actions/             # Review, Send, Post
    attendance/            # NEW: S57–S63
      Pass.tsx
      Scanner.tsx
      MyAttendance.tsx
    online-class/          # NEW: S64–S70
  styles/
    tokens-redesign.css    # NEW: Merged tokens
    ui-redesign.css        # NEW: Handoff UI utilities
  lib/
    cgpa.ts                # NEW: CGPA maths
    attendance.ts          # NEW: Crypto pass generation
    crypto.ts              # NEW: Web Crypto API wrappers

public/
  boxboy/                  # NEW: 5 persona assets
```

---

## Database Migrations

### Sprint 1: Foundation
```sql
-- 001_box_boy_personas.sql
ALTER TABLE profiles ADD COLUMN box_boy_persona TEXT 
  CHECK (box_boy_persona IN ('scholar', 'hustler', 'balanced', 'nightowl', 'social'));
```

### Sprint 2: Week 3
```sql
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

### Sprint 3: Week 4
```sql
-- 004_hoc_role.sql
ALTER TABLE profiles ADD COLUMN is_hoc BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN hoc_approved_at TIMESTAMP;
ALTER TABLE profiles ADD COLUMN hoc_approved_by UUID REFERENCES profiles(user_id);

-- 005_hoc_posts.sql
CREATE TABLE hoc_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES profiles(user_id) NOT NULL,
  department_id UUID REFERENCES departments(id) NOT NULL,
  level INTEGER NOT NULL,
  type TEXT CHECK (type IN ('announcement', 'tip', 'question')) NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 006_lecturer_materials.sql
CREATE TABLE lecturer_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by UUID REFERENCES profiles(user_id) NOT NULL, -- HOC or lecturer
  course_id UUID REFERENCES courses(id) NOT NULL,
  week_number INTEGER NOT NULL,
  type TEXT CHECK (type IN ('slides', 'notes', 'past-paper')) NOT NULL,
  file_url TEXT NOT NULL, -- Supabase Storage path
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Sprint 4: Week 5–8
```sql
-- 007_flatten_lectures.sql
-- Backup lectures table first
CREATE TABLE lectures_backup AS SELECT * FROM lectures;

-- Merge progress into weeks
UPDATE weeks w
SET 
  is_studied = (
    SELECT is_studied FROM lectures l 
    WHERE l.week_id = w.id 
    ORDER BY lecture_number DESC LIMIT 1
  ),
  studied_at = (
    SELECT studied_at FROM lectures l 
    WHERE l.week_id = w.id 
    ORDER BY lecture_number DESC LIMIT 1
  )
WHERE EXISTS (SELECT 1 FROM lectures WHERE week_id = w.id);

-- Archive lectures table (don't drop, keep for rollback)
ALTER TABLE lectures RENAME TO lectures_archived;

-- 008_lecturer_onboarding.sql
ALTER TABLE profiles ADD COLUMN lecturer_onboarded BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN lecturer_courses UUID[] DEFAULT '{}';

-- 009_class_feed.sql
-- hoc_posts already created in 005
-- Add lecturer posts (same table, different author role)
-- No changes needed, just use hoc_posts renamed to class_posts
ALTER TABLE hoc_posts RENAME TO class_posts;
```

### Sprint 5: After Week 8
```sql
-- 010_attendance_setup.sql
ALTER TABLE profiles ADD COLUMN attendance_full_name TEXT;
ALTER TABLE profiles ADD COLUMN attendance_matric TEXT;

-- 011_attendance_records.sql
CREATE TABLE attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES profiles(user_id) NOT NULL,
  class_id UUID REFERENCES classes(id) NOT NULL,
  scanned_by UUID REFERENCES profiles(user_id) NOT NULL,
  scanned_at TIMESTAMP DEFAULT NOW(),
  scan_location TEXT,
  verified BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_attendance_student ON attendance_records(student_id);
CREATE INDEX idx_attendance_class ON attendance_records(class_id);

-- 012_device_keys.sql
CREATE TABLE device_keys (
  user_id UUID REFERENCES profiles(user_id) PRIMARY KEY,
  device_pubkey TEXT NOT NULL,
  registered_at TIMESTAMP DEFAULT NOW()
);

-- 013_online_classes.sql
CREATE TABLE online_class_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID REFERENCES classes(id) NOT NULL,
  meet_link TEXT,
  started_at TIMESTAMP,
  ended_at TIMESTAMP
);

CREATE TABLE online_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES online_class_sessions(id) NOT NULL,
  student_id UUID REFERENCES profiles(user_id) NOT NULL,
  checkin_1 TIMESTAMP,
  checkin_2 TIMESTAMP,
  checkin_3 TIMESTAMP,
  marked_present BOOLEAN GENERATED ALWAYS AS (
    (checkin_1 IS NOT NULL)::int + 
    (checkin_2 IS NOT NULL)::int + 
    (checkin_3 IS NOT NULL)::int >= 2
  ) STORED
);
```

---

## Testing Strategy

### Unit Tests
- [ ] CGPA maths: `calculateNeededGPA()` with edge cases (5.0 target, 0.0 current)
- [ ] Persona selection: PERSONAS constant matches assets
- [ ] Attendance crypto: key generation, signing, verification
- [ ] Online class check-ins: 2-of-3 logic

### Integration Tests
- [ ] Onboarding flow: Splash → Persona → First class
- [ ] CGPA Planner: Enter → Course status → Target → Plan
- [ ] HOC request: Submit → Admin approval → Tools appear
- [ ] Attendance: Setup → Generate pass → Scan → Verify

### E2E Tests (Playwright)
- [ ] Student journey: Sign up → Pick persona → Set CGPA target → Study first week
- [ ] HOC journey: Become class rep → Post announcement → Upload materials
- [ ] Lecturer journey: Onboard → Confirm class → Scan attendance → Post materials

### Visual Regression
- [ ] All 102 screens match handoff designs (Percy or Chromatic)
- [ ] Dark mode: Both Classic & Story render correctly
- [ ] Persona carousel: Curved layout, center selection

---

## Rollout Plan

### Phase 1: Foundation (Internal)
- Team tests new design system on staging
- No user-facing changes yet

### Phase 2: Week 3 Beta (Nov 15)
- **New signups only:** See new onboarding + Box Boy personas
- **Existing users:** Keep old flow, add "Try new look" toggle in Settings
- Measure: Onboarding completion rate (old vs new)

### Phase 3: Week 4 Launch (Nov 22)
- **All users:** New Home, CGPA Planner, HOC tools go live
- Feature flags: CGPA Planner can be disabled if maths breaks
- Measure: Day-1 retention, CGPA target set rate

### Phase 4: Week 8 Full Redesign (Dec 20)
- **All users:** New lecturer side, attendance system, online classes
- **Breaking change:** Lecture 1/2/3 flattened (migration runs overnight)
- Measure: Lecturer adoption, attendance usage

---

## Success Metrics

| Metric | Current (v1.26.15) | Target (v2.0.0) | How to Measure |
|--------|-------------------|----------------|----------------|
| **Onboarding completion** | ~60% (assumption) | 75%+ | GA4 funnel: Splash → First class |
| **Day-1 retention** | ~40% (assumption) | 55%+ | Users who return day 2 after signup |
| **CGPA target set** | 0% (doesn't exist) | 50%+ | % of users who complete S15–S18 |
| **Notes studied per week** | Unknown | +20% | Avg studied_weeks per active user |
| **HOC adoption** | 0% (doesn't exist) | 10 HOCs by Week 8 | Count of is_hoc = TRUE |
| **Lecturer onboarding** | 0% (no redesign) | 5 lecturers by Week 8 | Count of lecturer_onboarded = TRUE |
| **Attendance scans** | 0% (doesn't exist) | 100 scans in first week | Count of attendance_records after launch |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Lecture flattening breaks existing notes** | HIGH | Keep lectures_archived table, test migration on staging with real data |
| **CGPA maths wrong for edge cases** | MEDIUM | Unit tests + manual QA with 0.0, 5.0, negative remaining units |
| **Attendance crypto too complex** | MEDIUM | Simplify to server-signed pass only, defer device keys to v2.1 |
| **Handoff fonts (Bowlby) don't load** | LOW | Keep Playfair fallback, test on slow 3G |
| **Box Boy personas feel childish** | MEDIUM | A/B test personas vs plain avatars, measure retention |
| **HOC approval backlog** | LOW | Auto-approve first 5 HOCs, then gate on admin review |
| **Lecturer side underused** | MEDIUM | Faculty proposal includes training, not just tech delivery |

---

## Open Questions (To Resolve Before Implementation)

1. **Verified class lists:** Handoff says "still being designed." Build placeholder or skip entirely?
2. **Save PDF removal:** User chose to remove it. Any grace period or announcement?
3. **Lecture flattening:** Keep archived table forever or drop after 6 months?
4. **Box Boy personas:** 5 is final, or add "Create custom" option later?
5. **Attendance crypto:** Ed25519 or ECDSA P-256? (Ed25519 smaller, P-256 more supported)
6. **Online classes:** Support Zoom + Meet, or Meet only?

---

## Next Immediate Steps

1. **Verify repo is clean** (double-check for malware traces)
2. **Create feature branch:** `git checkout -b feat/redesign-phase1-foundation`
3. **Extract design system:**
   ```bash
   cp -r docs/unify-learn-ui/unify-learn-ui/src/styles apps/web/src/styles/redesign/
   cp -r docs/unify-learn-ui/unify-learn-ui/src/components apps/web/src/components/redesign/
   cp -r docs/unify-learn-ui/unify-learn-ui/public/boxboy apps/web/public/
   ```
4. **Update tokens for amber:**
   ```css
   /* apps/web/src/styles/redesign/tokens.css */
   --u-amber: #fbbf24;  /* Primary CTA color */
   --u-green: #50ff90;  /* Success/non-CTA accent */
   ```
5. **Commit foundation:**
   ```bash
   git add .
   git commit -m "feat(redesign): Phase 1 foundation - design system + Box Boy assets"
   ```
6. **Begin Sprint 2:** Onboarding redesign with persona carousel (S11)

---

**End of Implementation Plan**  
Last updated: November 2, 2026  
Version: v1.0
