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

const SCORE_ACHIEVEMENTS = [
  { minimum: 0,  key: "0",  icon: "🚏", label: "도전자" },
  { minimum: 10, key: "10", icon: "🚉", label: "입문" },
  { minimum: 20, key: "20", icon: "🛤️", label: "탐험" },
  { minimum: 30, key: "30", icon: "🚈", label: "질주" },
  { minimum: 40, key: "40", icon: "🚇", label: "숙련" },
  { minimum: 50, key: "50", icon: "🗺️", label: "전문가" },
  { minimum: 60, key: "60", icon: "⚡", label: "고수" },
  { minimum: 70, key: "70", icon: "💎", label: "달인" },
  { minimum: 80, key: "80", icon: "🌟", label: "마스터" },
  { minimum: 90, key: "90", icon: "👑", label: "레전드" },
  { minimum: 95, key: "95", icon: "🌌", label: "초월" },
];

function scoreAchievement(adjustedScore) {
  const score = Math.max(0, Math.min(100, Number(adjustedScore) || 0));
  return [...SCORE_ACHIEVEMENTS].reverse().find(tier => score >= tier.minimum);
}

function rankingPlacementBadge(rank, percentileBonus) {
  const position = Number(rank);
  if (position === 1) return { key: "first", icon: "🥇", label: "1위" };
  if (position === 2) return { key: "second", icon: "🥈", label: "2위" };
  if (position === 3) return { key: "third", icon: "🥉", label: "3위" };
  if (position >= 4 && position <= 10) return { key: "top-ten", icon: `${position}위`, label: "TOP 10" };

  // 백분위 점수는 전체 참가자 내 백분위(최대 30점)이므로 27점부터 상위 10%다.
  if (Number(percentileBonus) >= PERCENTILE_SCORE_WEIGHT * 0.9) {
    return { key: "top-percent", icon: `${position}위`, label: "상위 10%" };
  }
  return null;
}
