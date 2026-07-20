/* ============================================================
   util.js — 공용 유틸리티 (전역)
   ------------------------------------------------------------
   여러 모듈이 각자 복제하던 헬퍼를 한곳에 모았다.
   반드시 다른 스크립트보다 먼저 로드한다.
   ============================================================ */

// DOM 셀렉터 단축
const $ = sel => document.querySelector(sel);

// HTML 이스케이프 (치환 맵은 호출마다 새로 만들지 않도록 상수로 고정)
const HTML_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => HTML_ESCAPE_MAP[c]);
}

// 노선 색상. id가 없거나 노선을 못 찾으면 fallback 색을 반환한다.
// (data.js/layout.js의 lineById에 의존 — 런타임에만 호출되므로 로드 순서 무관)
function lineColor(id, fallback = "#0052A4") {
  if (!id) return fallback;
  const l = (typeof lineById === "function") ? lineById(id) : null;
  return l ? l.color : fallback;
}

// 마지막으로 본 메시지(lastSeenId) 이후 새 메시지 개수. 폴링이 여러 개를 한꺼번에
// 가져와도 정확히 증가시키기 위한 순수 함수(테스트 용이). lastSeenId가 목록에 없으면
// (윈도우 밖으로 밀려남) 전체를 새 것으로 간주한다.
function countNewMessages(list, lastSeenId) {
  if (!Array.isArray(list) || list.length === 0) return 0;
  if (lastSeenId == null) return 0;
  const idx = list.findIndex(m => String(m.id) === String(lastSeenId));
  if (idx >= 0) return list.length - 1 - idx;
  // last-seen이 목록에 없음: 윈도우 밖으로 밀렸거나, 마지막으로 본 메시지가 숨김/삭제됐다.
  // id는 단조 증가하므로 "본 것보다 엄격히 큰 id"만 새 메시지로 센다(숨김 시 과다 카운트 방지).
  const seen = Number(lastSeenId);
  if (Number.isFinite(seen)) return list.filter(m => Number(m.id) > seen).length;
  return list.length;
}

// 클립보드 복사(비동기). navigator.clipboard 우선, 없거나 실패하면 execCommand 폴백.
// iOS WKWebView(인앱)는 Range+setSelectionRange가 있어야 execCommand("copy")가 동작한다.
// 반환: 복사 성공 여부(boolean). 호출부는 반드시 이 값으로 성공 UI를 표시해야 한다
// (예전엔 각 호출부가 실패해도 "복사됨"을 띄우는 거짓 성공 버그가 있었다).
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 폴백으로 진행 */ }
  }
  let ta = null;
  try {
    ta = document.createElement("textarea");
    ta.value = text;
    ta.contentEditable = "true";
    ta.readOnly = false;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, text.length);
    ta.select();
    return document.execCommand("copy");
  } catch (e) {
    return false;
  } finally {
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
  }
}
