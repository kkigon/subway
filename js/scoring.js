/* ============================================================
   랭킹 점수 보정
   - 기록 점수 70점: 이론 최고 기록 대비 달성률의 제곱근
   - 백분위 보너스 30점: 같은 분야 참가자 내 백분위
   - 분야별 이론 최고점은 항상 100점
   ============================================================ */

const RECORD_SCORE_WEIGHT = 70;
const PERCENTILE_SCORE_WEIGHT = 30;

function theoreticalMaxScore(durationSeconds, stationCount, revealDelayMs = 500) {
  const timeMaximum = Math.ceil((durationSeconds * 1000) / revealDelayMs);
  return Math.max(1, Math.min(stationCount, timeMaximum));
}

function rankingScoreParts(score, theoreticalMaximum, percentile) {
  const ratio = Math.max(0, Math.min(1, score / Math.max(1, theoreticalMaximum)));
  const pct = Math.max(0, Math.min(1, percentile));
  const recordPoints = RECORD_SCORE_WEIGHT * Math.sqrt(ratio);
  const percentileBonus = PERCENTILE_SCORE_WEIGHT * pct;
  return {
    recordPoints,
    percentileBonus,
    adjustedScore: recordPoints + percentileBonus,
  };
}
