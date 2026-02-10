const mongoose = require('mongoose');

const vaishnavaCalenderSchema = new mongoose.Schema({
    year: { type: Number, required: true },
    month: { type: Number, required: true },
    data: [
        {
            date: { type: Date, required: true },
            event: { type: String, required: true },
            description: { type: String },
        }
    ],
}, { timestamps: true });

module.exports = mongoose.model('VaishnavaCalender', vaishnavaCalenderSchema);
