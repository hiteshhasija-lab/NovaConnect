const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const uploadRoot = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const BLOCKED_EXTENSIONS = new Set(['.exe', '.sh', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.js', '.jar', '.app']);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadRoot,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) return cb(new Error(`Files of type "${ext}" are not allowed.`));
    cb(null, true);
  }
});

module.exports = { upload, uploadRoot, MAX_FILE_SIZE };
