/**
 * Migration script: base64 image strings & local files → MongoDB GridFS
 *
 * Run once with:  node migrate-images-to-gridfs.js
 *
 * It is safe to re-run; already-migrated documents (where the field value
 * is a GridFS ObjectId string, not a data: URL or /uploads/ path) are skipped.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { uploadToGridFS } = require('./utils/gridfs');

const isBase64DataUrl = (str) =>
  typeof str === 'string' && str.startsWith('data:');

const isLocalUploadPath = (str) =>
  typeof str === 'string' && str.startsWith('/uploads/');

const extractBufferAndMime = (dataUrl) => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  return {
    mimetype: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
};

const migrateField = async (doc, fieldPath, modelName, save) => {
  const value = doc[fieldPath];
  if (!value) return false;

  let buffer;
  let mimetype;
  let ext;

  if (isBase64DataUrl(value)) {
    const parsed = extractBufferAndMime(value);
    if (!parsed) return false;
    buffer = parsed.buffer;
    mimetype = parsed.mimetype;
    ext = mimetype.split('/')[1] || 'bin';
  } else if (isLocalUploadPath(value)) {
    // Determine absolute path on disk
    // value is like '/uploads/payment-screenshots/123.png'
    // __dirname is the backend folder
    const relativePath = value.replace(/^\/+/, ''); // remove leading slash
    const absolutePath = path.join(__dirname, relativePath);

    if (!fs.existsSync(absolutePath)) {
      console.warn(`  [WARN] ${modelName} ${doc._id} field "${fieldPath}": Local file not found at ${absolutePath}`);
      return false;
    }

    buffer = fs.readFileSync(absolutePath);
    ext = path.extname(absolutePath).slice(1) || 'bin';
    mimetype = 'application/octet-stream';
    if (ext === 'png') mimetype = 'image/png';
    else if (ext === 'jpg' || ext === 'jpeg') mimetype = 'image/jpeg';
    else if (ext === 'webp') mimetype = 'image/webp';
  } else {
    // Already migrated (or unsupported format)
    return false;
  }

  const filename = `${modelName}_${fieldPath}_${doc._id}.${ext}`;
  const fileId = await uploadToGridFS(buffer, filename, mimetype);
  doc[fieldPath] = String(fileId);
  await save();
  console.log(`  ✓ ${modelName} ${doc._id} → field "${fieldPath}" migrated (${Math.round(buffer.length / 1024)} KB)`);
  return true;
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  let total = 0;

  const targetRegex = /^(?:data:|\/uploads\/)/;

  // ── Gallery ──────────────────────────────────────────────────────────────
  const Gallery = require('./models/Gallery');
  const galleryDocs = await Gallery.find({ image: { $regex: targetRegex } });
  console.log(`Gallery: ${galleryDocs.length} document(s) to migrate`);
  for (const doc of galleryDocs) {
    const migrated = await migrateField(doc, 'image', 'Gallery', () => doc.save());
    if (migrated) total++;
  }

  // ── Events ────────────────────────────────────────────────────────────────
  const Event = require('./models/Event');
  const eventDocs = await Event.find({
    $or: [
      { image: { $regex: targetRegex } },
      { paymentQRCode: { $regex: targetRegex } }
    ]
  });
  console.log(`\nEvents: ${eventDocs.length} document(s) to migrate`);
  for (const doc of eventDocs) {
    let migrated = false;
    if (isBase64DataUrl(doc.image) || isLocalUploadPath(doc.image)) {
      migrated = await migrateField(doc, 'image', 'Event', () => doc.save()) || migrated;
    }
    if (isBase64DataUrl(doc.paymentQRCode) || isLocalUploadPath(doc.paymentQRCode)) {
      migrated = await migrateField(doc, 'paymentQRCode', 'Event', () => doc.save()) || migrated;
    }
    if (migrated) total++;
  }

  // ── Applications (payment screenshots) ────────────────────────────────────
  const Application = require('./models/Application');
  const appDocs = await Application.find({ paymentScreenshot: { $regex: targetRegex } });
  console.log(`\nApplications: ${appDocs.length} document(s) to migrate`);
  for (const doc of appDocs) {
    const migrated = await migrateField(doc, 'paymentScreenshot', 'Application', () => doc.save());
    if (migrated) total++;
  }

  // ── Settings (college logo) ────────────────────────────────────────────────
  const Settings = require('./models/Settings');
  const settingsDocs = await Settings.find({ collegeLogo: { $regex: targetRegex } });
  console.log(`\nSettings: ${settingsDocs.length} document(s) to migrate`);
  for (const doc of settingsDocs) {
    const migrated = await migrateField(doc, 'collegeLogo', 'Settings', () => doc.save());
    if (migrated) total++;
  }

  console.log(`\nDone. ${total} field(s) migrated to GridFS.`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
