# Seed review — catalog vs Artifacts/*.xlsx (Oct 2026)

77 missing courses were appended to `supabase/seed.sql` (Aerospace AAE/ASE block + departmental gaps).
Source rows without a semester land on First Semester; source rows with placeholder titles were skipped (below).
Seed inserts are idempotent (`on conflict do nothing`) — re-running the seed only adds, never rewrites.

## Needs a human decision (level conflicts: seed vs faculty sheets)

The sheets say one level, the seed says another. Course codes (401 = 400-level style) usually agree with the seed,
so these are listed — not auto-changed. Confirm per row, then fix in seed.sql or the sheet.

- BUL 507 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester'), ('500 Level', 'First Semester')] | Law for Engineers / for Non-Law Students
- CPE 401 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Chemical Engineering Analysis
- CPE 403 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Separation Process III
- CPE 405 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Chemical Reaction Engineering I
- CPE 407 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Biochemical Engineering I
- CPE 409 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Chemical Engineering Lab. III
- CPE 411 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Polymer Processing Engineering II
- CPE 415 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Polymer Engineering Laboratory III
- CPE 417 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Introduction to Plant Design
- ECE 401 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester'), ('400 Level', 'First Semester')] | Engineering Mathematics V
- ECE 419 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester'), ('400 Level', 'First Semester')] | Technical Communication
- ECO 403 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester'), ('400 Level', 'First Semester')] | Economics for Engineers
- MEE 101 | seed=[('100 Level', 'First Semester')] | sheets=[('100 Level', 'First Semester'), ('200 Level', 'First Semester')] | Engineer in Society (Carryover/Registered)
- MEE 401 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Applied Thermodynamics II
- MEE 403 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Machine Design II
- MEE 405 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Fluid Mechanics III
- MEE 407 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Vibrations
- MEE 411 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Engineering Materials Selection and Economics
- MEE 413 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Technology Policy and Development
- MEE 415 | seed=[('400 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Laboratory Practical
- MEE 492 | seed=[('400 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Application of Engineering Design to Industry
- MEE 494 | seed=[('400 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Safety and Reliability in Nigeria Companies
- MEE 496 | seed=[('400 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Engineering Enterprise
- MEE 498 | seed=[('400 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | SIWES III (24 Weeks Compulsory Industrial Att
- MEE 501 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Applied Thermodynamics III
- MEE 502 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester'), ('500 Level', 'Second Semester')] | Engineering Management
- MEE 503 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Machine Design III
- MEE 504 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester'), ('500 Level', 'Second Semester')] | Energy Sources and Conversion
- MEE 505 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Laboratory Practical
- MEE 506 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Thermal Engines
- MEE 507 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Advanced Mechanics of Materials I
- MEE 508 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Operational Research
- MEE 509 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Advanced Fluid Mechanics I
- MEE 510 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Advance Fluid Mechanics II
- MEE 511 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Heat and Mass Transfer
- MEE 512 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Mechanics of Metal Forming II
- MEE 513 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Mechanics of Metal Forming I
- MEE 514 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Advanced Mechanics of Materials II
- MEE 515 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Maintenance Engineering
- MEE 516 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Production Engineering II
- MEE 517 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Fluid Machinery
- MEE 518 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Industrial Engineering
- MEE 519 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Iron Making
- MEE 520 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Steel Making
- MEE 521 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Refractory Technology
- MEE 523 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Project Drafting Lab.
- MEE 524 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Foundry Technology
- MEE 525 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Air-Conditioning and Refrigeration
- MEE 526 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Engineering Systems Analysis
- MEE 528 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Engineering Metallurgy II
- MEE 534 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Advanced CAD/CAM
- MEE 535 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Production Engineering I
- MEE 598 | seed=[('500 Level', 'Second Semester')] | sheets=[('300 Level', 'Second Semester')] | Project II
- MEE 599 | seed=[('500 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester')] | Project I

## Skipped rows (placeholder titles, need real names)

- AAE 451 | Restricted Elective | ['400 Level'] | [] (skipped: placeholder/empty)
- AAE 485 | Restricted Elective | ['400 Level'] | [] (skipped: placeholder/empty)
- AAE 555 | Restricted Elective | ['500 Level'] | [] (skipped: placeholder/empty)
- AAE 597 | Compulsory | ['500 Level'] | [] (skipped: placeholder/empty)
- ASE 524 | Restricted Elective | ['500 Level'] | [] (skipped: placeholder/empty)
- ASE 588 | Restricted Elective | ['500 Level'] | [] (skipped: placeholder/empty)
- ECE 398 | Compulsory | ['300 Level'] | [] (skipped: placeholder/empty)
- ECE 498 | Compulsory | ['400 Level'] | [] (skipped: placeholder/empty)
- IPE 315 | Compulsory | ['300 Level'] | [] (skipped: placeholder/empty)

## Semester-only differences (no action: seed kept, sheets lack semester detail)

These differ only because the source row carries no semester, so the comparison assumed both.
Seed placement stands unless the list above says otherwise.

- AAE 102 | seed=[('100 Level', 'Second Semester')] | sheets=[('100 Level', 'First Semester'), ('100 Level', 'Second Semester')] | Introduction to Aerospace Engineering
- AAE 421 | seed=[('400 Level', 'First Semester')] | sheets=[('400 Level', 'First Semester'), ('400 Level', 'Second Semester')] | Structural Dynamics
- AAE 498 | seed=[('400 Level', 'Second Semester')] | sheets=[('400 Level', 'First Semester'), ('400 Level', 'Second Semester')] | Industrial Experience (SIWES)
- AAE 551 | seed=[('500 Level', 'First Semester')] | sheets=[('500 Level', 'First Semester'), ('500 Level', 'Second Semester')] | Restricted Elective
- ASE 201 | seed=[('200 Level', 'First Semester')] | sheets=[('200 Level', 'First Semester'), ('200 Level', 'Second Semester')] | Introduction to Aerospace Systems Engineering
- ASE 202 | seed=[('200 Level', 'Second Semester')] | sheets=[('200 Level', 'First Semester'), ('200 Level', 'Second Semester')] | MATLAB Application to Aerospace Engineering
- ASE 351 | seed=[('300 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester'), ('300 Level', 'Second Semester')] | Aircraft Structural Materials
- ASE 508 | seed=[('500 Level', 'Second Semester')] | sheets=[('500 Level', 'First Semester'), ('500 Level', 'Second Semester')] | Airline Enterprise Operations
- CHE 206 | seed=[('200 Level', 'Second Semester')] | sheets=[('200 Level', 'First Semester'), ('200 Level', 'Second Semester')] | Fundamentals of Thermodynamics
- ECE 202 | seed=[('200 Level', 'Second Semester')] | sheets=[('200 Level', 'First Semester'), ('200 Level', 'Second Semester')] | Engineering Mathematics II
- ECE 303 | seed=[('300 Level', 'First Semester')] | sheets=[('300 Level', 'First Semester'), ('300 Level', 'Second Semester')] | Electrical Circuit Theory
- ECE 492 | seed=[('400 Level', 'Second Semester')] | sheets=[('400 Level', 'First Semester'), ('400 Level', 'Second Semester')] | Application of Engineering Design to Industry
- ECE 502 | seed=[('500 Level', 'First Semester')] | sheets=[('500 Level', 'First Semester'), ('500 Level', 'Second Semester')] | Cyberpreneurship & CyberLaw
- ENT 312 | seed=[('300 Level', 'Second Semester')] | sheets=[('300 Level', 'First Semester'), ('300 Level', 'Second Semester')] | Venture Creation
- GNS 212 | seed=[('200 Level', 'Second Semester')] | sheets=[('200 Level', 'First Semester'), ('200 Level', 'Second Semester')] | Philosophy, Logic and Human Existence and Gen
- GNS 312 | seed=[('300 Level', 'Second Semester')] | sheets=[('300 Level', 'First Semester'), ('300 Level', 'Second Semester')] | Peace and Conflict Resolution
- MEE 202 | seed=[('200 Level', 'Second Semester')] | sheets=[('200 Level', 'First Semester'), ('200 Level', 'Second Semester')] | Engineering Materials
- MEE 204 | seed=[('200 Level', 'Second Semester')] | sheets=[('200 Level', 'First Semester'), ('200 Level', 'Second Semester')] | Students Workshop Experience
