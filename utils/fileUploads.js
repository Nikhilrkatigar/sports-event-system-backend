const { uploadToGridFS, deleteFromGridFS } = require('./gridfs');

const uploadFile = async (file) => {
  if (!file || !file.buffer) return null;
  const fileId = await uploadToGridFS(file.buffer, file.originalname || 'upload', file.mimetype);
  return String(fileId);
};

module.exports = { uploadFile, deleteFromGridFS };
