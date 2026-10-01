const createAsyncRouter = require('../asyncRouter');
const multer = require('multer');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
function createProfilePhotoRouter({ db, requireAuth, directory }) {
const router = createAsyncRouter();
const root = directory || path.join(process.env.LOCAL_UPLOAD_ROOT || path.join(__dirname, '../../data/uploads'), 'profile-photos');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 } }).single('file');
const { photoType, initialsSVG } = require('../profilePhoto');
router.use(requireAuth);
router.post('/', (req, res, next) => upload(req, res, err => err ? res.status(400).json({ error: 'Choose one JPEG or PNG picture up to 5 MB.' }) : next()), async (req, res) => {
  if (!req.file || !photoType(req.file.buffer)) return res.status(400).json({ error: 'Choose a valid JPEG or PNG picture.' });
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, String(req.session.user.id));
  const temp = target + '.' + crypto.randomUUID();
  try {
    await fs.writeFile(temp, req.file.buffer, { mode: 0o600 });
    await fs.rename(temp, target);
  } finally { await fs.rm(temp, { force: true }); }
  if (req.body.return_to_profile === '1') return res.redirect('/profile');
  res.json({ ok: true });
});
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(400);
  const user = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(id);
  if (!user) return res.sendStatus(404);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  try {
    const data = await fs.readFile(path.join(root, String(id)));
    const type = photoType(data);
    if (!type) return res.sendStatus(404);
    res.type(type).send(data);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    res.type('image/svg+xml').send(initialsSVG(user.full_name));
  }
});
return router;
}
module.exports = { createProfilePhotoRouter };
