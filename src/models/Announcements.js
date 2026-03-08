const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
    title: { type: String, required: true },
    subtitle: { type: String, required: false },
    shareText: { type: String, required: false },
    image: { type: String, required: true },
    date: { type: Date, required: true },
    location: { type: String, required: false }
}, { timestamps: true });

module.exports = mongoose.model('Announcement', announcementSchema);
