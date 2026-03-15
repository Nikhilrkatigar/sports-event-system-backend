const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Gallery } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/gallery';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

router.get('/', async (req, res) => {
  try {
    const items = await Gallery.find().sort({ createdAt: -1 });
    res.json(items);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, requirePermission('manage_gallery'), upload.single('image'), async (req, res) => {
  try {
    const data = { caption: req.body.caption };
    if (req.file) data.image = `/uploads/gallery/${req.file.filename}`;
    else data.image = req.body.imageUrl;
    const item = new Gallery(data);
    await item.save();
    res.status(201).json(item);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/:id', auth, requirePermission('manage_gallery'), async (req, res) => {
  try {
    await Gallery.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
