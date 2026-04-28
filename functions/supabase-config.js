// Cloudflare Pages Function - serves Supabase config from environment variables
// Set SUPABASE_URL and SUPABASE_KEY in Cloudflare Pages > Settings > Environment variables
export async function onRequest(context) {
  var url = context.env.SUPABASE_URL;
  var key = context.env.SUPABASE_KEY;
  if (!url || !key) {
    return new Response('// Supabase config not set', {
      status: 500,
      headers: { 'Content-Type': 'application/javascript' }
    });
  }
  var js = 'window.__SUPABASE_CONFIG={url:"' + url + '",key:"' + key + '"};';
  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'private, no-store'
    }
  });
}
