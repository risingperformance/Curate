window.__SUPABASE_CONFIG={url:"https://mlwzpgtdgfaczgxipbsq.supabase.co",key:"sb_publishable_bzfK6YCmPIcYm8LfMe1CGA_lS-QETHZ"};
// Public origin (including any sub-path) used in customer-facing links
// sent over email (booking invitations, share-draft, etc.). Set to the
// production URL so emails sent during local testing still produce links
// the customer can open. In production this is also used as the trusted
// base when window.location is on localhost during preview.
window.__APP_CONFIG = window.__APP_CONFIG || {
  publicOrigin: "https://risingperformance.github.io/Curate/cloudflare-deploy"
};
// Feature flags. Default values; per-app overrides may apply at boot
// (e.g. URL hash and localStorage keys read by app.js).
//   slideStrip - footwear deck product strip + drawer. Default ON since
//                Phase 6 of the slide-product-strip refactor (2026-05-06).
//                Override to false via localStorage 'fw.flags.slideStrip'
//                = '0' or URL hash &strip=0 to disable for testing.
window.__FW_FLAGS = window.__FW_FLAGS || { slideStrip: true };
