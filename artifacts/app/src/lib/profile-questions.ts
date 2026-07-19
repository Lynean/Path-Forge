// Shared between onboarding and the profile edit page so both offer the exact same
// language list (matches what the tutor's system prompt understands as a language name).
export const LANGUAGE_OPTIONS: string[] = [
  "English",
  "Vietnamese",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Spanish",
  "French",
  "German",
  "Japanese",
  "Korean",
  "Portuguese",
  "Arabic",
  "Hindi",
  "Indonesian",
  "Thai",
  "Russian",
];

// These interest categories mirror the project types the AI tutor already detects from
// a project's title/description (see `detectProjectTypes` in the api-server's
// aiNodeChat.ts) so a learner's declared interests line up with how the tutor actually
// calibrates its teaching approach.
export interface InterestOption {
  key: string;
  label: string;
}

export const INTEREST_OPTIONS: InterestOption[] = [
  { key: "algorithm", label: "Algorithms / Competitive Programming" },
  { key: "math-impl", label: "Machine Learning / AI" },
  { key: "hardware", label: "Hardware / Embedded Systems" },
  { key: "robotics", label: "Robotics / Simulation" },
  { key: "workflow-tools", label: "Workflow / No-Code Tools (Excel, n8n, Power BI...)" },
  { key: "cybersecurity", label: "Cybersecurity" },
  { key: "data-analytics", label: "Data Analytics / Data Science" },
  { key: "enterprise-integration", label: "Enterprise / API Integration" },
  { key: "document-heavy", label: "Technical Documentation / Datasheets" },
  { key: "theory", label: "Pure Math / Theory" },
];

export interface ExperienceQuestion {
  question: string;
  options: string[];
}

// One experience question per interest category, asked only for categories the learner
// selected. Options run from no exposure to professional-level, worded per domain.
export const EXPERIENCE_QUESTIONS: Record<string, ExperienceQuestion> = {
  algorithm: {
    question: "How much experience do you have with algorithms / competitive programming?",
    options: [
      "Never solved algorithm problems",
      "Solved some easy/medium problems casually",
      "Regularly practice — solved 100+ problems",
      "Competitive programmer / contest experience",
    ],
  },
  "math-impl": {
    question: "How much experience do you have with machine learning / AI?",
    options: [
      "No ML experience",
      "Completed a course or tutorial",
      "Built and trained models on my own projects",
      "Professional or research ML experience",
    ],
  },
  hardware: {
    question: "How much experience do you have with hardware / embedded systems?",
    options: [
      "Never worked with hardware or electronics",
      "Basic Arduino/breadboard projects",
      "Built multiple embedded projects",
      "Professional embedded/hardware engineering experience",
    ],
  },
  robotics: {
    question: "How much experience do you have with robotics?",
    options: [
      "No robotics experience",
      "Completed ROS/robotics tutorials",
      "Built a robotics project (simulation or real)",
      "Professional or research robotics experience",
    ],
  },
  "workflow-tools": {
    question: "How much experience do you have with workflow / no-code tools?",
    options: [
      "Never used workflow or no-code tools",
      "Basic spreadsheet or simple automation use",
      "Built multi-step workflows or automations",
      "Professional experience with enterprise workflow tools",
    ],
  },
  cybersecurity: {
    question: "How much experience do you have with cybersecurity?",
    options: [
      "No security experience",
      "Completed security courses or CTFs casually",
      "Regular CTF player / built security tools",
      "Professional pentesting or security experience",
    ],
  },
  "data-analytics": {
    question: "How much experience do you have with data analytics / data science?",
    options: [
      "No data analysis experience",
      "Basic spreadsheet or SQL queries",
      "Built data pipelines or analysis projects",
      "Professional data analyst/scientist experience",
    ],
  },
  "enterprise-integration": {
    question: "How much experience do you have with API/enterprise integration?",
    options: [
      "No API or integration experience",
      "Used a few APIs / simple integrations",
      "Built multi-system integrations",
      "Professional integration/enterprise engineering experience",
    ],
  },
  "document-heavy": {
    question: "How comfortable are you working from technical documentation / datasheets?",
    options: [
      "Rarely read technical docs or datasheets",
      "Comfortable navigating documentation",
      "Regularly work from datasheets/specs",
      "Professional experience authoring or interpreting technical specs",
    ],
  },
  theory: {
    question: "How much background do you have in this area of pure math/theory?",
    options: [
      "Haven't studied this beyond the basics",
      "Completed relevant coursework",
      "Comfortable with proofs and derivations",
      "Research or advanced theoretical background",
    ],
  },
};

export const OTHER_KEY = "other";

/**
 * Condenses selected interests + per-interest experience answers (plus optional free-text
 * "Other" entries for both) into one natural-language profile summary string, so the
 * backend can keep using a single free-text field instead of separate structured ones.
 */
export function buildProfileSummary(params: {
  selectedInterestKeys: string[];
  otherInterest: string;
  experienceByKey: Record<string, string>;
  otherExperience: string;
}): string {
  const { selectedInterestKeys, otherInterest, experienceByKey, otherExperience } = params;

  const interestLabels = selectedInterestKeys
    .map((key) => INTEREST_OPTIONS.find((o) => o.key === key)?.label)
    .filter((label): label is string => Boolean(label));
  if (otherInterest.trim()) interestLabels.push(otherInterest.trim());

  const interestsLine = interestLabels.length > 0 ? `Interested in: ${interestLabels.join(", ")}.` : "";

  const experienceParts = selectedInterestKeys
    .map((key) => {
      const label = INTEREST_OPTIONS.find((o) => o.key === key)?.label;
      const answer = experienceByKey[key];
      return label && answer ? `${label}: ${answer}` : null;
    })
    .filter((part): part is string => Boolean(part));
  if (otherInterest.trim() && otherExperience.trim()) {
    experienceParts.push(`${otherInterest.trim()}: ${otherExperience.trim()}`);
  }

  const experienceLine = experienceParts.length > 0 ? `Experience — ${experienceParts.join("; ")}.` : "";

  return [interestsLine, experienceLine].filter(Boolean).join("\n");
}
