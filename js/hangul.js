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

// 유니코드 코드포인트 단위로 문자열을 뒤집는다.
// 한글 음절과 이모지의 surrogate pair가 깨지지 않도록 split("") 대신 전개 연산자를 쓴다.
function reverseText(str) {
  return [...String(str || "")].reverse().join("");
}

// 거꾸로 모드에서 허용할 표시명/별칭 후보.
// 예) "총신대입구(이수)" → [")수이(구입대신총", "구입대신총", "수이"]
function reverseNameCandidates(displayName) {
  const candidates = new Set([displayName]);
  const m = String(displayName || "").match(/^(.+?)\((.+?)\)$/);
  if (m) { candidates.add(m[1]); candidates.add(m[2]); }
  return [...candidates].map(reverseText);
}

// 자동완성/정답 공개용 표시명. 괄호까지 통째로 뒤집지 않고 각 이름만 뒤집어 읽기 쉽게 보인다.
// 예) "총신대입구(이수)" → "구입대신총 (수이)"
function reverseDisplayName(displayName) {
  const name = String(displayName || "");
  const m = name.match(/^(.+?)\((.+?)\)$/);
  return m ? `${reverseText(m[1])} (${reverseText(m[2])})` : reverseText(name);
}

function matchesReverseAnswer(input, displayName) {
  const n = normalizeName(input);
  if (!n) return false;
  return reverseNameCandidates(displayName).some(candidate => normalizeName(candidate) === n);
}

// 검색 점수: 정확(3) > 접두(2) > 포함(1) > 초성 접두(0.5) / 불일치(-1)
// 괄호 별칭(예: "총신대입구(이수)"의 "이수")도 후보로 함께 평가해 최고점을 사용
function searchScore(query, displayName) {
  const q = normalizeName(query);
  if (!q) return -1;
  const isChosungQuery = /^[ㄱ-ㅎ]+$/.test(query.replace(/\s/g, ""));

  // 표시명 + 괄호 별칭들을 모두 후보로
  const candidates = [displayName];
  const m = displayName.match(/^(.+?)\((.+?)\)$/);
  if (m) { candidates.push(m[1], m[2]); }

  let best = -1;
  for (const cand of candidates) {
    const name = normalizeName(cand);
    let score = -1;
    if (name === q) score = 3;
    else if (name.startsWith(q)) score = 2;
    else if (name.includes(q)) score = 1;
    else if (isChosungQuery) {
      const cho = normalizeName(toChosung(cand));
      if (cho.startsWith(q)) score = 0.5;
    }
    if (score > best) best = score;
  }
  return best;
}

// 거꾸로 표시명과 거꾸로 별칭을 모두 검색 대상으로 삼는다.
function reverseSearchScore(query, displayName) {
  return Math.max(...reverseNameCandidates(displayName).map(candidate => searchScore(query, candidate)));
}
