/* ============================================================
   한글 유틸 — 초성 추출 / 이름 정규화 / 검색 매칭
   ============================================================ */

const CHOSUNG = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

// 문자열에서 초성만 추출 (한글이 아닌 글자는 그대로)
function toChosung(str) {
  let out = "";
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      out += CHOSUNG[Math.floor((code - 0xac00) / 588)];
    } else {
      out += ch;
    }
  }
  return out;
}

// 비교용 정규화: 공백/가운뎃점/마침표 제거
function normalizeName(str) {
  return (str || "")
    .normalize("NFC")
    .replace(/[\s·.\u00b7\u2027]/g, "")
    .toLowerCase();
}

// 역 이름에서 허용되는 정답 후보들 생성
// 예) "총신대입구(이수)" → ["총신대입구(이수)", "총신대입구", "이수"]
function nameAliases(displayName) {
  const aliases = new Set([displayName]);
  const m = displayName.match(/^(.+?)\((.+?)\)$/);
  if (m) {
    aliases.add(m[1]);
    aliases.add(m[2]);
  }
  return [...aliases].map(normalizeName);
}

// 입력값이 역 이름과 일치하는지
function matchesAnswer(input, displayName) {
  const n = normalizeName(input);
  if (!n) return false;
  return nameAliases(displayName).includes(n);
}

// 검색 점수: 정확(3) > 접두(2) > 포함(1) > 초성 접두(0.5) / 불일치(-1)
function searchScore(query, displayName) {
  const q = normalizeName(query);
  if (!q) return -1;
  const name = normalizeName(displayName);
  if (name === q) return 3;
  if (name.startsWith(q)) return 2;
  if (name.includes(q)) return 1;
  const cho = normalizeName(toChosung(displayName));
  const qCho = normalizeName(q);
  if (/^[ㄱ-ㅎ]+$/.test(query.replace(/\s/g, "")) && cho.startsWith(qCho)) return 0.5;
  return -1;
}
