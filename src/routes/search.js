const createAsyncRouter = require('../asyncRouter');
const { requireAuth } = require('../middleware/auth');
const { searchMessages } = require('../search');

const router = createAsyncRouter();
router.use(requireAuth);

router.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Number(req.query.offset) || 0;
  const sortParam = req.query.sort || 'created_at:desc';
  const sort = sortParam.split(',').map(s => s.trim());

  if (!q) return res.json({ hits: [], estimatedTotalHits: 0, query: '', processingTimeMs: 0 });

  try {
    const result = await searchMessages(req.session.user.id, q, { limit, offset, sort });
    res.json(result);
  } catch (e) {
    console.error('Global search error:', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;