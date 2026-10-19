import type { Criterion } from '@/types';

/**
 * Rubric id for new sessions. Stored rubrics can't change, so use a new id when you edit
 * the criteria below or data/rubric/rubric.txt (otherwise session creation fails).
 */
export const RUBRIC_ID = 'essay-v1';

// Criteria of rubric essay-v1, as written in data/rubric/rubric.txt.
export const RUBRIC_CRITERIA: Criterion[] = [
  {
    id: 1,
    name: 'Content',
    scoreRange: { min: 1, max: 5 },
    levels: [
      { score: 1, description: 'No clear position or completely off-topic.' },
      { score: 2, description: 'A position is stated but reasons or examples are missing or irrelevant.' },
      { score: 3, description: 'Position is clear with some supporting reasons; examples may be limited or underdeveloped.' },
      { score: 4, description: 'Position is well-supported with relevant reasons and examples; argument is mostly consistent.' },
      { score: 5, description: 'Position is clearly argued throughout with strong, relevant reasons and specific examples.' },
    ],
  },
  {
    id: 2,
    name: 'Organization',
    scoreRange: { min: 1, max: 5 },
    levels: [
      { score: 1, description: 'No discernible structure; very hard to follow.' },
      { score: 2, description: 'Some attempt at structure but ideas are jumbled or transitions are absent.' },
      { score: 3, description: 'Basic structure is present; ideas are mostly in order but connections between paragraphs are weak.' },
      { score: 4, description: 'Clear structure with logical paragraph order and transitions that help the reader follow the argument.' },
      { score: 5, description: 'Well-organized throughout; each paragraph develops a single idea and connects clearly to the overall argument.' },
    ],
  },
  {
    id: 3,
    name: 'Language',
    scoreRange: { min: 1, max: 5 },
    levels: [
      { score: 1, description: 'Frequent grammatical errors that make the essay difficult to understand.' },
      { score: 2, description: 'Several errors that distract from meaning, though the message is recoverable.' },
      { score: 3, description: 'Meaning is generally clear; errors are present but do not seriously affect comprehension.' },
      { score: 4, description: 'Mostly accurate grammar and vocabulary; errors are minor and infrequent.' },
      { score: 5, description: 'Accurate grammar throughout with a varied vocabulary; writing is fluent and easy to read.' },
    ],
  },
];
