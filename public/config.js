// ============================================================
//  MELTADO DRIVE-IN — SETTINGS YOU EDIT
// ============================================================
//  Leave SUPABASE_URL / SUPABASE_ANON_KEY empty to run in DEMO MODE.
//  Demo mode keeps orders inside one browser only (open the customer
//  page and the counter page in two tabs of the same browser to try it).
//  Fill them in (see README.md, Step 3) to go live.
// ============================================================
window.APP_CONFIG = {
  CAFE_NAME: "Meltado",
  CAFE_PHONE: "",            // e.g. "+919876543210" — shown as a "Call cafe" button

  SUPABASE_URL: "https://kvgjmcbwhlmytfedbjlc.supabase.co",          // e.g. "https://abcdxyz.supabase.co"
  SUPABASE_ANON_KEY: "sb_publishable_2prJc_afSkoKkfPM4fNY1g_22Fhfb83",     // Supabase > Project Settings > API > anon public key

  // DEMO MODE ONLY. In live mode these come from the app_settings table in Supabase.
  CAFE_LAT: 28.6542,         // approximate — confirm with an exact Google Maps pin before launch
  CAFE_LNG: 77.3025,         // approximate — confirm with an exact Google Maps pin before launch
  RADIUS_M: 500,             // 1 km diameter = 500 m radius
  GPS_SLACK_M: 50,           // small tolerance for GPS drift
  REQUIRE_OTP: false,        // live mode reads this from Supabase instead
};
