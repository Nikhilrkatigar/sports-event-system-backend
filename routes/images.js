const router = require('express').Router();
const mongoose = require('mongoose');
const { getFileStream, getBucket } = require('../utils/gridfs');

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

    const file = files[0];
    res.set('Content-Type', file.contentType || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');

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
