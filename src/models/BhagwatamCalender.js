const mongoose = require('mongoose');

const bhagwatamCalenderSchema = new mongoose.Schema({
    date: { type: Date, required: true, unique: true },
    speaker: { type: String, required: true },
    verse: { type: String, required: true },
    url: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('BhagwatamCalender', bhagwatamCalenderSchema);