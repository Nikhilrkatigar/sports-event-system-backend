// Database backup/restore without needing mongodump installed.
//   node backup.js                         -> backups/<timestamp>/<collection>.jsonl (includes uploaded images)
//   node backup.js --restore backups/<dir> -> restores into collections that are EMPTY (never overwrites)
// Backups contain student personal data: keep them private, never commit them.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;

const backup = async (db) => {
  const dir = path.join(__dirname, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const collections = await db.listCollections({ type: 'collection' }).toArray();
  for (const { name } of collections) {
    const out = fs.createWriteStream(path.join(dir, `${name}.jsonl`));
    let count = 0;
    for await (const doc of db.collection(name).find()) {
      // Respect backpressure so large image collections don't fill memory
      if (!out.write(EJSON.stringify(doc, { relaxed: false }) + '\n')) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      count++;
    }
    await new Promise((resolve) => out.end(resolve));
    console.log(`  ${name}: ${count}`);
  }
  console.log(`Backup written to ${dir}`);
};

const restore = async (db, dir) => {
  if (!dir || !fs.existsSync(dir)) throw new Error(`Backup folder not found: ${dir}`);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const name = file.slice(0, -'.jsonl'.length);
    const collection = db.collection(name);
    if (await collection.estimatedDocumentCount() > 0) {
      console.log(`  ${name}: skipped (collection not empty)`);
      continue;
    }
    let batch = [];
    let count = 0;
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(dir, file)) });
    for await (const line of lines) {
      if (!line.trim()) continue;
      batch.push(EJSON.parse(line, { relaxed: false }));
      if (batch.length === 500) {
        await collection.insertMany(batch);
        count += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await collection.insertMany(batch);
      count += batch.length;
    }
    console.log(`  ${name}: ${count} restored`);
  }
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}`);
  const restoreIndex = process.argv.indexOf('--restore');
  if (restoreIndex !== -1) await restore(db, process.argv[restoreIndex + 1]);
  else await backup(db);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
