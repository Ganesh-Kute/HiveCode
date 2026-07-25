const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading data:', err.message);
  }
  return { habits: [] };
}

function save(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving data:', err.message);
    throw err;
  }
}

module.exports = { load, save };