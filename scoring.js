// Scoring rules. Max 1000 points per question.
// Tweak the constants below after a test round if you want a different feel.

const MAX_POINTS = 1000;
const MC_MIN_FRACTION = 0.5;   // multiple choice: a correct answer at the last second still gets 50%
const NUMBER_EXPONENT = 1;     // number guess accuracy curve: 1 = linear (each % off costs the same), 2 = harsh/quadratic
const NUMBER_MIN_SPEED = 0.5;  // number guess: a perfect guess at the last second still gets 50% (same as multiple choice)
const DEFAULT_TOLERANCE_FRACTION = 1.0; // if admin sets no tolerance: 100% of the answer (a guess off by that much gets 0)

// Multiple choice: linear in answer time. Wrong answers are handled by the caller (0 points).
function scoreMultipleChoice(timeMs, limitMs) {
  const ratio = Math.min(Math.max(timeMs / limitMs, 0), 1);
  return Math.round(MAX_POINTS * (1 - (1 - MC_MIN_FRACTION) * ratio));
}

function defaultTolerance(answer) {
  return Math.max(Math.abs(answer) * DEFAULT_TOLERANCE_FRACTION, 1);
}

// Number guess = accuracy x speed.
//   accuracy: exact = 1, error >= tolerance = 0, linear in between (with the default tolerance of 100% of the
//             answer: 10% off -> 90%, 25% off -> 75%, 50% off -> 50%).
//   speed:    same as multiple choice, instant = 1, last second = 0.5.
// timeMs / limitMs are optional; without them only accuracy counts.
function scoreNumber(guess, answer, tolerance, timeMs, limitMs) {
  const tol = tolerance > 0 ? tolerance : defaultTolerance(answer);
  const accuracy = Math.pow(Math.max(0, 1 - Math.abs(guess - answer) / tol), NUMBER_EXPONENT);
  const ratio = limitMs > 0 && timeMs >= 0 ? Math.min(timeMs / limitMs, 1) : 0;
  const speed = 1 - (1 - NUMBER_MIN_SPEED) * ratio;
  return Math.round(MAX_POINTS * accuracy * speed);
}

module.exports = { scoreMultipleChoice, scoreNumber, defaultTolerance, MAX_POINTS };
