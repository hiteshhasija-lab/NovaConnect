// GIF search backed by Giphy's API — proxied server-side so the API key never reaches the
// client. Mirrors ai.js's own "not configured yet" pattern: with no GIPHY_API_KEY set, every
// route returns configured:false and an empty result set rather than an error, so the picker
// UI can show a friendly message instead of breaking.
const createAsyncRouter = require('../asyncRouter');
const { requireAuth } = require('../middleware/auth');

const router = createAsyncRouter();
router.use(requireAuth);

const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';
const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';

async function giphyFetch(path, params) {
  const url = new URL(GIPHY_BASE + path);
  url.searchParams.set('api_key', GIPHY_API_KEY);
  url.searchParams.set('rating', 'pg-13');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Giphy API error ${res.status}`);
  const data = await res.json();
  return (data.data || []).map(g => ({
    id: g.id,
    title: g.title || 'GIF',
    preview: (g.images.fixed_width_small || g.images.fixed_width || {}).url,
    url: (g.images.fixed_width || g.images.original || {}).url
  })).filter(g => g.preview && g.url);
}

router.get('/api/gifs/trending', async (req, res) => {
  if (!GIPHY_API_KEY) return res.json({ configured: false, gifs: [] });
  try {
    res.json({ configured: true, gifs: await giphyFetch('/trending', { limit: 24 }) });
  } catch (e) { res.status(502).json({ error: 'Could not reach Giphy.' }); }
});

router.get('/api/gifs/search', async (req, res) => {
  if (!GIPHY_API_KEY) return res.json({ configured: false, gifs: [] });
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json({ configured: true, gifs: [] });
  try {
    res.json({ configured: true, gifs: await giphyFetch('/search', { q, limit: 24 }) });
  } catch (e) { res.status(502).json({ error: 'Could not reach Giphy.' }); }
});

module.exports = router;
