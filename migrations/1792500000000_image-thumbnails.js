// Image thumbnails (Phase 3, "Files"; src/thumbnails.js): a small copy of a picture, stored next to
// the upload with the driver used for it, and the original's size so the page can keep its space.
// thumb_state: 'done' (has one) or 'none' (not a picture it could read), set for every new upload;
// NULL on rows from before, which the start-up backfill (src/attachments.js) works through once.
exports.up = (pgm) => {
  pgm.addColumn('attachments', {
    thumb_key: { type: 'text' },
    thumb_driver: { type: 'text' },
    thumb_mime: { type: 'text' },
    image_width: { type: 'integer' },
    image_height: { type: 'integer' },
    thumb_state: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('attachments', ['thumb_key', 'thumb_driver', 'thumb_mime', 'image_width', 'image_height', 'thumb_state']);
};
