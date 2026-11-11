/**
 * Unify Note Schema Validator & Hard Quality Rules Enforcement
 */

const NOTE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["course", "week", "title", "subtitle", "learningOutcome", "metaChips", "tags", "topics", "eoq"],
  properties: {
    course: { type: "string" },
    week: { type: "integer" },
    title: { type: "string" },
    subtitle: { type: "string" },
    learningOutcome: { type: "string" },
    metaChips: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    topics: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["number", "title", "abbr", "subtopics", "activeRecall", "pulseCheck"],
        properties: {
          number: { type: "integer" },
          title: { type: "string" },
          abbr: { type: "string" },
          subtopics: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["number", "title", "abbr", "content", "miniCheck"],
              properties: {
                number: { type: "string" },
                title: { type: "string" },
                abbr: { type: "string" },
                content: { type: "array" },
                miniCheck: {
                  type: "object",
                  required: ["questions"],
                  properties: {
                    questions: { type: "array", minItems: 1 }
                  }
                }
              }
            }
          },
          activeRecall: { type: "array", minItems: 1 },
          pulseCheck: {
            type: "object",
            required: ["number", "questions"],
            properties: {
              number: { type: "integer" },
              questions: { type: "array", minItems: 3, maxItems: 3 }
            }
          }
        }
      }
    },
    eoq: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: { type: "array", minItems: 10, maxItems: 10 }
      }
    }
  }
};

/**
 * Math-delimiter check: every \(...\) and \[...\] in a quiz string must be
 * balanced, or MathJax leaves raw LaTeX on screen. Returns error strings.
 * This is HOW quiz math is confirmed before publish — the Studio review
 * lists each hit so the author fixes the exact question.
 */
function mathIssues(label, texts) {
  const out = [];
  for (const t of texts) {
    if (typeof t !== "string" || !t) continue;
    // Ignore escaped backslashes (\\) so literal text isn't flagged.
    const s = t.replace(/\\\\/g, "");
    const openI = (s.match(/\\\(/g) || []).length;
    const closeI = (s.match(/\\\)/g) || []).length;
    const openD = (s.match(/\\\[/g) || []).length;
    const closeD = (s.match(/\\\]/g) || []).length;
    if (openI !== closeI || openD !== closeD) {
      out.push(`${label}: unbalanced math delimiters — the equation will show as raw text. Fix the \\( \\) or \\[ \\] pairing.`);
    } else {
      // Bare single underscore outside math (T_2) renders literally — it
      // must sit inside \( \). Runs of __+ are FITB blanks, not errors.
      const stripped = s.replace(/\\\(.*?\\\)/g, "").replace(/\\\[.*?\\\]/g, "");
      if (/(?<!\\)(?<!_)_(?!_)/.test(stripped)) {
        out.push(`${label}: bare subscript outside math delimiters — wrap it in \\( \\) so it renders.`);
      }
    }
  }
  return out;
}

/**
 * Validate a note JSON against the schema and UNIFY_RULES quality checklist.
 * @param {object} data Note JSON
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateUnifyNote(data) {
  const errors = [];

  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Data must be a non-null JSON object."] };
  }

  // Basic required fields
  const reqFields = ["course", "week", "title", "subtitle", "learningOutcome", "metaChips", "tags", "topics", "eoq"];
  for (const field of reqFields) {
    if (!data[field]) {
      errors.push(`Missing required top-level field: '${field}'.`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Validate Topics & Subtopics
  if (!Array.isArray(data.topics) || data.topics.length === 0) {
    errors.push("Topic array must contain at least 1 topic.");
  } else {    data.topics.forEach((topic, tIdx) => {
      const topicNum = topic.number || (tIdx + 1);

      if (!topic.title) errors.push(`Topic ${topicNum}: missing title.`);
      if (!Array.isArray(topic.subtopics) || topic.subtopics.length === 0) {
        errors.push(`Topic ${topicNum}: must have at least 1 subtopic.`);
      } else {
        topic.subtopics.forEach((sub, sIdx) => {
          const subNum = sub.number || `${topicNum}.${sIdx + 1}`;
          
          // Rule: Every subtopic must have a miniCheck with >= 1 question
          if (!sub.miniCheck || !Array.isArray(sub.miniCheck.questions) || sub.miniCheck.questions.length === 0) {
            errors.push(`Subtopic ${subNum} ('${sub.title || 'Untitled'}'): missing Mini Check questions (every subtopic must have a Mini Check).`);
          } else {
            // Check question-type rotation (no back-to-back duplicate types)
            let prevType = null;
            sub.miniCheck.questions.forEach((q, qIdx) => {
              if (!q.type) {
                errors.push(`Subtopic ${subNum} Mini Check Q${qIdx + 1}: missing question type.`);
              } else if (q.type === prevType && sub.miniCheck.questions.length > 1) {
                errors.push(`Subtopic ${subNum} Mini Check Q${qIdx + 1}: repeated question type '${q.type}' back-to-back.`);
              }
              prevType = q.type;

              // Check FITB acceptedAnswers
              if (q.type === "fitb") {
                if (!Array.isArray(q.acceptedAnswers) || q.acceptedAnswers.length === 0) {
                  errors.push(`Subtopic ${subNum} Mini Check Q${qIdx + 1} (FITB): missing acceptedAnswers array.`);
                }
              }
              // Quiz math confirmation: question + options + answers must
              // carry balanced delimiters or they render as raw LaTeX.
              errors.push(
                ...mathIssues(`Subtopic ${subNum} Mini Check Q${qIdx + 1}`, [
                  q.question,
                  ...((q.options || [])),
                  ...((q.acceptedAnswers || [])),
                  q.answer,
                ])
              );
            });
          }
        });
      }

      // Validate Active Recall
      if (!Array.isArray(topic.activeRecall) || topic.activeRecall.length < 1) {
        errors.push(`Topic ${topicNum}: must contain at least 1 Active Recall card.`);
      }

      // Validate Pulse Check: exactly 3 questions in MCQ, MCQ, FITB order
      if (!topic.pulseCheck || !Array.isArray(topic.pulseCheck.questions)) {
        errors.push(`Topic ${topicNum}: missing Pulse Check.`);
      } else if (topic.pulseCheck.questions.length !== 3) {
        errors.push(`Topic ${topicNum}: Pulse Check must have exactly 3 questions (got ${topic.pulseCheck.questions.length}).`);
      } else {
        const qTypes = topic.pulseCheck.questions.map(q => q.type);
        if (qTypes[0] !== "mcq" || qTypes[1] !== "mcq" || qTypes[2] !== "fitb") {
          errors.push(`Topic ${topicNum}: Pulse Check questions must be ordered [MCQ, MCQ, FITB] (got [${qTypes.join(", ")}]).`);
        }
      }
    });
  }

  // Validate EOQ: exactly 10 questions, at least 6 MCQ (others: fitb, number, maths)
  if (!data.eoq || !Array.isArray(data.eoq.questions)) {
    errors.push("EOQ section missing or questions array invalid.");
  } else if (data.eoq.questions.length !== 10) {
    errors.push(`EOQ must contain exactly 10 questions (got ${data.eoq.questions.length}).`);
  } else {
    let mcqCount = 0;
    let otherCount = 0;

    data.eoq.questions.forEach((q, idx) => {
      const qNum = q.number || (idx + 1);
      if (q.type === "mcq") mcqCount++;
      else if (q.type === "fitb" || q.type === "number" || q.type === "maths") otherCount++;
      else errors.push(`EOQ Q${qNum}: type must be mcq, fitb, number or maths.`);
      // Number: a numeric answer (tolerance and unit optional). Maths: at least one accepted expression.
      if (q.type === "number" && !(typeof q.answer === "number" && Number.isFinite(q.answer))) {
        errors.push(`EOQ Q${qNum}: a number question needs a numeric 'answer'.`);
      }
      if (q.type === "maths" && !(Array.isArray(q.acceptedAnswers) && q.acceptedAnswers.some((a) => typeof a === "string" && a.trim()))) {
        errors.push(`EOQ Q${qNum}: a maths question needs at least one accepted expression.`);
      }

      if (!q.question) errors.push(`EOQ Q${qNum}: missing question text.`);
      if (!q.feedback || (!q.feedback.correct && !q.feedback.c) || (!q.feedback.wrong && !q.feedback.w)) {
        errors.push(`EOQ Q${qNum}: missing feedback object with 'correct' and 'wrong' strings.`);
      }
      if (!q.topicRef) errors.push(`EOQ Q${qNum}: missing topicRef string for student review list.`);
      errors.push(
        ...mathIssues(`EOQ Q${qNum}`, [
          q.question,
          ...((q.options || [])),
          ...((q.acceptedAnswers || [])),
          q.feedback && (q.feedback.correct || q.feedback.c),
          q.feedback && (q.feedback.wrong || q.feedback.w),
        ])
      );
    });

    // At least 6 multiple choice; the rest can be fill-in, number or maths answers.
    if (mcqCount < 6 || mcqCount + otherCount !== 10) {
      errors.push(`EOQ needs 10 questions with at least 6 multiple choice (found ${mcqCount} MCQ and ${otherCount} others).`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  NOTE_SCHEMA,
  validateUnifyNote
};
