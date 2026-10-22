const createAsyncRouter = require('../asyncRouter');
const multer = require('multer');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
// Where profile photos live: files in a folder (local driver), or objects in the bucket (s3 driver).
// With s3, a photo that was saved before the switch is still read from the folder.
function localPhotoStore(root) {
  return {
    async read(id) {
      try { return await fs.readFile(path.join(root, String(id))); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async write(id, buffer) {
      await fs.mkdir(root, { recursive: true });
      const target = path.join(root, String(id));
      const temp = target + '.' + crypto.randomUUID();
      try {
        await fs.writeFile(temp, buffer, { mode: 0o600 });
        await fs.rename(temp, target);
      } finally { await fs.rm(temp, { force: true }); }
    },
  };
}
function s3PhotoStore(local) {
  const storage = require('../storage');
  const key = (id) => `profile-photos/${id}`;
  return {
    async read(id) { return (await storage.readObject(key(id))) || local.read(id); },
    async write(id, buffer, type) { await storage.writeObject(key(id), buffer, type); },
  };
}
function createProfilePhotoRouter({ db, requireAuth, directory, store }) {
  const router = createAsyncRouter();
  const root = directory || path.join(process.env.LOCAL_UPLOAD_ROOT || path.join(__dirname, '../../data/uploads'), 'profile-photos');
  const local = localPhotoStore(root);
  const photos = store || (!directory && process.env.STORAGE_DRIVER === 's3' ? s3PhotoStore(local) : local);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 } }).single('file');
  const { photoType, initialsSVG } = require('../profilePhoto');
  router.use(requireAuth);
  router.post('/', (req, res, next) => upload(req, res, err => err ? res.status(400).json({ error: 'Choose one JPEG or PNG picture up to 5 MB.' }) : next()), async (req, res) => {
    if (!req.file || !photoType(req.file.buffer)) return res.status(400).json({ error: 'Choose a valid JPEG or PNG picture.' });
    await photos.write(req.session.user.id, req.file.buffer, photoType(req.file.buffer));
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
    // If the bucket cannot be reached the person's initials are shown instead (not an error on every avatar).
    const data = await photos.read(id).catch((error) => { console.error('Profile photo read failed:', error.message); return null; });
    const type = data && photoType(data);
    if (data && !type) return res.sendStatus(404);
    if (!data) return res.type('image/svg+xml').send(initialsSVG(user.full_name));
    res.type(type).send(data);
  });
  return router;
}
module.exports = { createProfilePhotoRouter };
