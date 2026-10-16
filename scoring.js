// Scoring rules. Max 1000 points per question.
// Tweak the constants below after a test round if you want a different feel.

const MAX_POINTS = 1000;
const MC_MIN_FRACTION = 0.5;   // multiple choice: a correct answer at the last second still gets 50%
const NUMBER_EXPONENT = 2;     // number guess: 2 = quadratic falloff, spreads the top of a big field
const DEFAULT_TOLERANCE_FRACTION = 0.5; // if admin sets no tolerance: 50% of the answer

// Multiple choice: linear in answer time. Wrong answers are handled by the caller (0 points).
function scoreMultipleChoice(timeMs, limitMs) {
  const ratio = Math.min(Math.max(timeMs / limitMs, 0), 1);
  return Math.round(MAX_POINTS * (1 - (1 - MC_MIN_FRACTION) * ratio));
}

function defaultTolerance(answer) {
  return Math.max(Math.abs(answer) * DEFAULT_TOLERANCE_FRACTION, 1);
}

// Number guess: exact = 1000, error >= tolerance = 0, quadratic in between.
function scoreNumber(guess, answer, tolerance) {
  const tol = tolerance > 0 ? tolerance : defaultTolerance(answer);
  const closeness = Math.max(0, 1 - Math.abs(guess - answer) / tol);
  return Math.round(MAX_POINTS * Math.pow(closeness, NUMBER_EXPONENT));
}

module.exports = { scoreMultipleChoice, scoreNumber, defaultTolerance, MAX_POINTS };
