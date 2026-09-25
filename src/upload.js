const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { uploadFile, MAX_FILE_SIZE, STORAGE_DRIVER } = require('./storage');

const TEMP_UPLOAD_ROOT = path.join(__dirname, '..', 'data', 'tmp_uploads');
if (!fs.existsSync(TEMP_UPLOAD_ROOT)) fs.mkdirSync(TEMP_UPLOAD_ROOT, { recursive: true });

const BLOCKED_EXTENSIONS = new Set(['.exe', '.sh', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.js', '.jar', '.app']);

const upload = multer({
  storage: multer.diskStorage({
    destination: TEMP_UPLOAD_ROOT,
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

module.exports = { upload, MAX_FILE_SIZE, STORAGE_DRIVER, uploadFile };