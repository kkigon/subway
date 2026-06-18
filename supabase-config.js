/* ============================================================
   Supabase 접속 설정
   ------------------------------------------------------------
   여기 두 값을 네 프로젝트 값으로 바꿔야 로그인/랭킹이 동작해.

   값 찾는 곳:
   Supabase 대시보드 → 왼쪽 맨 아래 ⚙️ "Project Settings"
     → "API" 메뉴
       • Project URL          → SUPABASE_URL 에 붙여넣기
       • Project API keys 의 "anon public" 키 → SUPABASE_ANON_KEY 에 붙여넣기

   ⚠️ "anon public" 키는 브라우저에 공개돼도 안전하게 설계된 키야.
      (절대 "service_role" 키는 여기 넣지 마! 그건 비밀 키라 서버 전용이야.)
   ============================================================ */

const SUPABASE_URL = "https://zsamoefsfjkhqiinwepu.supabase.co";       // 예: https://abcd1234.supabase.co
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzYW1vZWZzZmpraHFpaW53ZXB1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NTYyNjIsImV4cCI6MjA5NzAzMjI2Mn0.I934jTZ-Oec0hSj3QRJDepfOhNAIjMDEWhr-I61ChHg"; // 예: eyJhbGciOi... (아주 긴 문자열)
