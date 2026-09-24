const router = require('express').Router();
const mongoose = require('mongoose');
const { getFileStream, getBucket } = require('../utils/gridfs');
const { Application } = require('../models');
const { verifyImageAccess, SAFE_IMAGE_TYPES } = require('../utils/fileUploads');

router.get('/:id', async (req, res) => {
  let fileId;
  try {
    fileId = new mongoose.Types.ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ message: 'Invalid image ID' });
  }

  try {
    const files = await getBucket().find({ _id: fileId }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ message: 'Image not found' });
    }

    // Payment screenshots need a signed link from the admin registrations list
    const isPrivate = await Application.exists({ paymentScreenshot: String(fileId) });
    if (isPrivate && !verifyImageAccess(fileId, req.query.sig)) {
      return res.status(403).json({ message: 'Not allowed' });
    }

    const file = files[0];
    // Anything that isn't a known raster image is downloaded, never rendered (blocks stored XSS from old uploads)
    if (SAFE_IMAGE_TYPES.has(file.contentType)) {
      res.set('Content-Type', file.contentType);
    } else {
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', 'attachment');
    }
    res.set('Cache-Control', isPrivate ? 'private, no-store' : 'public, max-age=31536000, immutable');

    const downloadStream = getFileStream(fileId);
    downloadStream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ message: 'Image not found' });
    });
    downloadStream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
});

module.exports = router;
