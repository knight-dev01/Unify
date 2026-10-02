---
name: "unify-course-notes"
description: "Turn raw course material (lecturer notes, past questions, solved scripts) into Unify-style weekly study notes in a doc. Use when building or extending course notes for students."
---

# Unify course notes

Build shareable study notes from raw course material: handwritten or scanned lecturer notes, past question papers, and classmates' solved scripts. The finished notes teach a beginner from the ground up, embed the past questions where each topic is taught, and are read by many students, not one.

Reference build: ECE 311 Measurement & Instrumentation, 12-Week Study Guide (Claude Docs). When unsure, match it.

## 1. Inputs and reading

- Read **every page** of every file before writing anything. Scanned PDFs have no text layer: read them as images, page by page.
- Sort the material into three piles: **lecturer notes** (the spine and the order), **question papers** (the exact wording, numbering and marks), **solutions** (classmates' or notebook working).
- Never invent question numbers, marks or years. Take them from the actual question paper. If you only have a solution set, say it is a solution set and use its numbering.
- If one paper repeats another under different numbers, say so once; it raises the priority of those topics.

## 2. Plan before writing

1. Split the lecturer notes into **one tab per week** (12 weeks by default, or as the user asks), following the notes' own order. Lighter weeks can carry supporting material from the notebooks.
2. Map every past question to the week where its topic is taught.
3. List topics the questions need but the notes lack. These get written into the week where they belong.
4. Re-run every number in code. List every mistake in the notes and the solutions (wrong sign, wrong formula, arithmetic slip, impossible answer such as a sensitivity above 1).

## 3. Doc structure

- One doc. Main tab **Start here** first, then the week tabs nested under it, named `Wk 01 · Topic` … `Wk 12 · Topic`, ordered b01…b12.
- **Start here** holds: a two-sentence lead; "How each week is built" (the list in section 4); a table `Wk | Topic | Practice questions from`; one line on repeated papers; a "Mistakes found in the materials" table `Where | As written | Should be | Wk`.
- Fill one week per write so readers can watch it build.

## 4. Every week tab, in this exact order

1. **Lead sentence:** "By the end of this week you can …" (what the student can do). No exam references here: never write "examined as …" or marks in the intro.
2. **## The big picture:** what the week is about and why it matters, in plain words, then a blockquote `> **Analogy.** …` using an everyday picture (market scale, phone clock, tyre gauge, see-saw, swing, shock absorbers).
3. **## Terms and symbols:** a table `Term or symbol | Meaning in plain words` covering every new word, symbol and abbreviation before it is used.
4. **## N.1, N.2 … numbered sections:** the course content. Formulas in formula boxes. Derivations broken into labelled steps ("Step 1. Fix the half-scale resistance."), each step saying *why*. After a key formula, one line "Read it as: …". Worked examples as "## Worked example: …" with a **Flow:** line.
5. **## Practice questions:** each question in bold with its source in brackets, e.g. `**Q2. … (2022/23 Q5b, 2, 2, 1, 1 marks; 2021/22 Q5b)**`. Then a **Flow:** line (e.g. "mean → deviations → check they sum to zero → average deviation"), then numbered steps with substitutions shown and the answer in bold with units. Say how the marks split when it helps.
6. **## Memory trick:** one or two hooks (an acronym, a story, a rhyme).
7. **## Common mistakes:** bullets of where marks are lost.
8. **## Check yourself:** a tick-list (`- [ ]`). A week is done when every box ticks without looking.

Extra material the notes don't cover goes in its own section ("More on ammeters") or inside the relevant section. Never label it "Added (not in your notes)".

## 5. Wording rules

- The notes are shared. Never write "your notes", "your classmate" or "from the lecturer's notes". Write "the notes", "the handwritten notes", "a classmate's solution", "the solved 2023/24 paper in the pack".
- Headings say **Practice questions**, never "Past questions, in place".
- Mistakes go in a blockquote: `> **Note.** The handwritten notes say X. It is Y, because …` Give the correct working. Never delete the original claim silently.
- Unresolvable gaps (missing data in a figure) are stated plainly, with an illustration if useful, and added to a "Questions to ask the lecturer" checklist in the final week.
- Don't cut content when restyling. Restructure it.
- Plain words, short sentences, units always (Ω, μA, kΩ/V, not "ohm", "microamp").

## 6. Maths and notation

- The doc has **no inline maths**: `$…$`, `\(…\)` and `<sub>` all show as raw text. Never use them.
- Full equations go in their own ```latex code blocks of bare TeX (no `$`). These render properly.
- Symbols inside sentences use real Unicode sub/superscripts: Rₘ, Iₘ, Rₕ, Rₜₕ, Vₜₕ, Rₓ, R₁, C₃, Lₓ, Iₛₕ, Rₘᵤ, Vₗ, x̄, dᵢ, R², 10⁻⁶, ω².
- Never write underscores or carets in prose (I_m, R^2). Never use small-capital look-alikes (ʟ, ᴅ, ʙ).
- Letters with no Unicode subscript (b, d, f, capital letters): use brackets in prose, e.g. V(RB), V(ADC), R(load), or keep the subscript inside a formula box. For quantities like I_fsd, choose one prose symbol (Iₘ = full-scale current), define it in the Terms table, and note "written I_fsd on exam papers".

## 7. Diagrams

The agent does **not** draw schematics. Text-art and ASCII circuits are not acceptable. Every figure becomes an empty, numbered diagram card for a contributor to draw in a schematic tool and paste in:

```
> **Diagram 10.1: Wheatstone bridge** *(to be added)*
>
> A diamond of four resistors: **R₁** top-left and **R₂** top-right (ratio arm), **R₃** bottom-left (variable, arrow through it), **Rₓ** bottom-right (unknown). Battery **E** from the top to the bottom corner. Galvanometer **G** across the left and right corners.
>
> *[ Insert schematic here ]*
```

- Number cards by week (Diagram 4.1, 4.2 …).
- Describe every component, which arm or branch it sits in, all labels, values and current directions, precisely enough to draw without the source.
- Add a card wherever the notes or the exam need a figure: circuits, scales, curves, phasor diagrams, construction sketches, and figures quoted in question papers. If a figure in a paper is illegible, the card says to copy it from the paper and confirm the layout.
- Separately mark sketches students should practise by hand with **[DRAW]**.

## 8. Final week

The last week carries any leftover topic from the notes plus revision:

- A table of which topics repeat across papers (`Topic | paper A | paper B | Week`).
- A formula sheet, grouped by week, in formula boxes.
- A mock-exam plan matching the real paper format (time, compulsory question, choice).
- "Questions to ask the lecturer" as a checklist.

## 9. Check before handing over

- Every number re-computed in code. Every "Note" correction re-verified against the source page.
- Every question number and mark checked against the actual question paper.
- Search the doc for `_`, `^`, `$`, "your", "From the lecturer", "Past questions" and fix what turns up (underscores inside formula boxes and the "written I_fsd on exam papers" line are fine).
- Every week has all eight parts of section 4 in order.