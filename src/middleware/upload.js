const path = require('path');
const fs = require('fs');
const multer = require('multer');
const env = require('../config/env');

const uploadDir = path.join(env.rootDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED = { 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'], 'application/pdf': ['.pdf'] };
const upload = multer({
  storage: multer.diskStorage({
    destination: (_q, _f, cb) => cb(null, uploadDir),
    filename: (_q, f, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(f.originalname || '').toLowerCase()}`)
  }),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024 },
  fileFilter: (_q, f, cb) => {
    const exts = ALLOWED[f.mimetype], ext = path.extname(f.originalname || '').toLowerCase();
    if (!exts || !exts.includes(ext)) return cb(new Error('Only image/PDF uploads are allowed.'));
    cb(null, true);
  }
});
module.exports = { upload, uploadDir };
