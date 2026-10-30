// File versions (Files; src/fileVersions.js): a file in a message can be replaced by a new version in
// place. The attachments row is always the current version (so downloads, thumbnails, forwarding,
// retention, legal hold and eDiscovery keep working as before); each version it replaced is kept in
// attachment_versions, still downloadable. version_no counts from 1; version_by/version_at say who
// put the current version there and when (uploaded_by stays the person who first shared the file).
exports.up = (pgm) => {
  pgm.addColumn('attachments', {
    version_no: { type: 'integer', notNull: true, default: 1 },
    version_comment: { type: 'text' },
    version_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    version_at: { type: 'text' },
  });
  pgm.createTable('attachment_versions', {
    id: 'id',
    attachment_id: { type: 'integer', notNull: true, references: 'attachments', onDelete: 'CASCADE' },
    version_no: { type: 'integer', notNull: true },
    filename: { type: 'text', notNull: true },
    storage_key: { type: 'text' },
    storage_driver: { type: 'text', notNull: true, default: 'local' },
    original_name: { type: 'text', notNull: true },
    mime_type: { type: 'text' },
    size: { type: 'integer' },
    uploaded_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    uploaded_at: { type: 'text', notNull: true },
    comment: { type: 'text' },
    thumb_key: { type: 'text' },
    thumb_driver: { type: 'text' },
    thumb_mime: { type: 'text' },
    image_width: { type: 'integer' },
    image_height: { type: 'integer' },
    thumb_state: { type: 'text' },
  }, { constraints: { unique: ['attachment_id', 'version_no'] } });
};

exports.down = (pgm) => {
  pgm.dropTable('attachment_versions');
  pgm.dropColumn('attachments', ['version_no', 'version_comment', 'version_by', 'version_at']);
};
