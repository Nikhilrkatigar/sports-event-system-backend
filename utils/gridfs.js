const mongoose = require('mongoose');
const { Readable } = require('stream');

let bucket = null;

const getBucket = () => {
  if (!bucket) {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
  }
  return bucket;
};

const uploadToGridFS = (buffer, filename, mimetype) => {
  return new Promise((resolve, reject) => {
    const b = getBucket();
    const uploadStream = b.openUploadStream(filename, { contentType: mimetype });
    const readable = Readable.from(buffer);
    readable.pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id));
  });
};

const deleteFromGridFS = async (fileId) => {
  try {
    const id = typeof fileId === 'string' ? new mongoose.Types.ObjectId(fileId) : fileId;
    await getBucket().delete(id);
  } catch {
    // ignore missing files
  }
};

const getFileStream = (fileId) => {
  const id = typeof fileId === 'string' ? new mongoose.Types.ObjectId(fileId) : fileId;
  return getBucket().openDownloadStream(id);
};

module.exports = { uploadToGridFS, deleteFromGridFS, getFileStream, getBucket };
