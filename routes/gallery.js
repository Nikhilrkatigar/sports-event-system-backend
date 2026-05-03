const router = require('express').Router();
const multer = require('multer');
const { Gallery } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { uploadFile, deleteFromGridFS } = require('../utils/fileUploads');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, fieldSize: 15 * 1024 * 1024 } });

router.get('/', async (req, res) => {
  try {
    const items = await Gallery.find().sort({ createdAt: -1 });
    res.json(items);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, requirePermission('manage_gallery'), upload.single('image'), async (req, res) => {
  try {
    const data = { caption: req.body.caption };
    if (req.file) {
      data.image = await uploadFile(req.file);
    } else {
      data.image = req.body.imageUrl || '';
    }
    const item = new Gallery(data);
    await item.save();
    res.status(201).json(item);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/:id', auth, requirePermission('manage_gallery'), async (req, res) => {
  try {
    const item = await Gallery.findByIdAndDelete(req.params.id);
    if (item && item.image && !item.image.startsWith('http')) {
      await deleteFromGridFS(item.image);
    }
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
