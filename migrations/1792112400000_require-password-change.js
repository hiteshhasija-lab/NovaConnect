exports.up = (pgm) => {
  pgm.addColumn('users', {
    must_change_password: { type: 'integer', notNull: true, default: 0 },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('users', 'must_change_password');
};
