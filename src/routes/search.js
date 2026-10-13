const createAsyncRouter = require('../asyncRouter');
const { requireAuth } = require('../middleware/auth');
const { globalSearch } = require('../search');

const router = createAsyncRouter();
router.use(requireAuth);

// One search bar across messages, files and people. Messages come from Meilisearch when it
// answers and from the database when it does not (see globalSearch in ../search.js); the response
// shape is the one public/js/workspace.js renders: { messages, files, people, source }.
router.get('/api/search', async (req, res) => {
  try {
    res.json(await globalSearch(req.session.user.id, req.query.q, { limit: req.query.limit }));
  } catch (e) {
    console.error('Global search error:', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;