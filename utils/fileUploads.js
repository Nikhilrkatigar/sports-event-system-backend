const jwt = require('jsonwebtoken');
const { uploadToGridFS, deleteFromGridFS } = require('./gridfs');

// Only raster images may be stored: they are served back from the API origin,
// so HTML/SVG uploads would run script there.
const SAFE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const uploadFile = async (file) => {
  if (!file || !file.buffer) return null;
  if (!SAFE_IMAGE_TYPES.has(file.mimetype)) {
    const err = new Error('Only JPEG, PNG, WebP, and GIF images are allowed');
    err.status = 400;
    throw err;
  }
  const fileId = await uploadToGridFS(file.buffer, file.originalname || 'upload', file.mimetype);
  return String(fileId);
};

// multer fileFilter: rejects before the upload is buffered
const imageFileFilter = (req, file, cb) => {
  if (SAFE_IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
  const err = new Error('Only JPEG, PNG, WebP, and GIF images are allowed');
  err.status = 400;
  cb(err, false);
};

const signImageAccess = (fileId) =>
  jwt.sign({ type: 'img', f: String(fileId) }, process.env.JWT_SECRET, { expiresIn: '8h' });

const verifyImageAccess = (fileId, sig) => {
  try {
    const decoded = jwt.verify(String(sig || ''), process.env.JWT_SECRET);
    return decoded.type === 'img' && decoded.f === String(fileId);
  } catch {
    return false;
  }
};

module.exports = { uploadFile, deleteFromGridFS, imageFileFilter, signImageAccess, verifyImageAccess, SAFE_IMAGE_TYPES };
