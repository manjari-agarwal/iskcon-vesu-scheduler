const { date } = require('joi');
const mongoose = require('mongoose');

const prabhuPaadQuotesSchema = new mongoose.Schema({
    day: { type: Number, required: true },
    month: { type: Number, required: true },
    hindiImage: { type: String, default: null },
    englishImage: { type: String, },
    englishText: { type: String, },
    hindiText: { type: String, default: null },
    prabhuPaadImage: { type: String, },
    footnoteHindi: { type: String, default: null },
    footnoteEnglish: { type: String, default: null },
});

module.exports = mongoose.model('PrabhuPaadQuotes', prabhuPaadQuotesSchema);
