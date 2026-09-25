exports.up = async (pgm) => {
  // Users table
  pgm.createTable('users', {
    id: 'id',
    username: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    full_name: { type: 'text', notNull: true },
    email: { type: 'text' },
    role: { type: 'text', notNull: true, default: 'member' },
    title: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'offline' },
    status_message: { type: 'text' },
    active: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
    last_seen_at: { type: 'text' },
    presence_preference: { type: 'text' },
    status_message_expires_at: { type: 'text' },
  });

  // Teams table
  pgm.createTable('teams', {
    id: 'id',
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    icon: { type: 'text', notNull: true, default: 'bi-people-fill' },
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
    require_approval: { type: 'integer', notNull: true, default: 0 },
  });

  // Team join requests
  pgm.createTable('team_join_requests', {
    id: 'id',
    team_id: { type: 'integer', notNull: true, references: 'teams', onDelete: 'CASCADE' },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });
  pgm.addConstraint('team_join_requests', 'unique_team_user', 'UNIQUE(team_id, user_id)');

  // Team members
  pgm.createTable('team_members', {
    id: 'id',
    team_id: { type: 'integer', notNull: true, references: 'teams', onDelete: 'CASCADE' },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true, default: 'member' },
    joined_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });
  pgm.addConstraint('team_members', 'unique_team_user', 'UNIQUE(team_id, user_id)');

  // Channels
  pgm.createTable('channels', {
    id: 'id',
    team_id: { type: 'integer', notNull: true, references: 'teams', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    is_private: { type: 'integer', notNull: true, default: 0 },
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });
  pgm.addConstraint('channels', 'unique_team_name', 'UNIQUE(team_id, name)');

  // Channel members
  pgm.createTable('channel_members', {
    id: 'id',
    channel_id: { type: 'integer', notNull: true, references: 'channels', onDelete: 'CASCADE' },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    joined_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
    role: { type: 'text', notNull: true, default: 'member' },
  });
  pgm.addConstraint('channel_members', 'unique_channel_user', 'UNIQUE(channel_id, user_id)');

  // DM conversations
  pgm.createTable('dm_conversations', {
    id: 'id',
    is_group: { type: 'integer', notNull: true, default: 0 },
    name: { type: 'text' },
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });

  // DM participants
  pgm.createTable('dm_participants', {
    id: 'id',
    conversation_id: { type: 'integer', notNull: true, references: 'dm_conversations', onDelete: 'CASCADE' },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    joined_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
    last_read_message_id: { type: 'integer' },
    is_favorite: { type: 'integer', notNull: true, default: 0 },
    is_muted: { type: 'integer', notNull: true, default: 0 },
    is_unread: { type: 'integer', notNull: true, default: 0 },
    is_hidden: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('dm_participants', 'unique_convo_user', 'UNIQUE(conversation_id, user_id)');

  // Chat reports
  pgm.createTable('chat_reports', {
    id: 'id',
    conversation_id: { type: 'integer', notNull: true, references: 'dm_conversations', onDelete: 'CASCADE' },
    reported_by: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    category: { type: 'text', notNull: true },
    reason: { type: 'text', notNull: true },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });

  // Messages
  pgm.createTable('messages', {
    id: 'id',
    channel_id: { type: 'integer', references: 'channels', onDelete: 'CASCADE' },
    conversation_id: { type: 'integer', references: 'dm_conversations', onDelete: 'CASCADE' },
    user_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    body: { type: 'text', notNull: true, default: '' },
    parent_message_id: { type: 'integer', references: 'messages', onDelete: 'CASCADE' },
    edited: { type: 'integer', notNull: true, default: 0 },
    deleted: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
    updated_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
    metadata: { type: 'text' },
    pinned_at: { type: 'text' },
    pinned_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
  });

  // Scheduled messages
  pgm.createTable('scheduled_messages', {
    id: 'id',
    channel_id: { type: 'integer', references: 'channels', onDelete: 'CASCADE' },
    conversation_id: { type: 'integer', references: 'dm_conversations', onDelete: 'CASCADE' },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    body: { type: 'text', notNull: true },
    parent_message_id: { type: 'integer', references: 'messages', onDelete: 'CASCADE' },
    send_at: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });

  // Blocked users
  pgm.createTable('blocked_users', {
    id: 'id',
    blocker_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    blocked_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });
  pgm.addConstraint('blocked_users', 'unique_blocker_blocked', 'UNIQUE(blocker_id, blocked_id)');

  // Message reactions
  pgm.createTable('message_reactions', {
    id: 'id',
    message_id: { type: 'integer', notNull: true, references: 'messages', onDelete: 'CASCADE' },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    emoji: { type: 'text', notNull: true },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });
  pgm.addConstraint('message_reactions', 'unique_message_user_emoji', 'UNIQUE(message_id, user_id, emoji)');

  // Attachments
  pgm.createTable('attachments', {
    id: 'id',
    message_id: { type: 'integer', notNull: true, references: 'messages', onDelete: 'CASCADE' },
    filename: { type: 'text', notNull: true },
    original_name: { type: 'text', notNull: true },
    mime_type: { type: 'text' },
    size: { type: 'integer' },
    uploaded_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    storage_driver: { type: 'text', notNull: true, default: 'local' },
    storage_key: { type: 'text' },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });

  // Notifications
  pgm.createTable('notifications', {
    id: 'id',
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    type: { type: 'text', notNull: true },
    actor_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    channel_id: { type: 'integer', references: 'channels', onDelete: 'CASCADE' },
    conversation_id: { type: 'integer', references: 'dm_conversations', onDelete: 'CASCADE' },
    message_id: { type: 'integer', references: 'messages', onDelete: 'CASCADE' },
    body: { type: 'text' },
    is_read: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
    team_id: { type: 'integer', references: 'teams', onDelete: 'CASCADE' },
    meeting_id: { type: 'integer', references: 'meetings', onDelete: 'CASCADE' },
  });

  // Meet links
  pgm.createTable('meet_links', {
    code: { type: 'text', primaryKey: true },
    title: { type: 'text', notNull: true },
    created_by: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    active: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });

  // Meetings
  pgm.createTable('meetings', {
    id: 'id',
    title: { type: 'text', notNull: true },
    details: { type: 'text', notNull: true, default: '' },
    location: { type: 'text', notNull: true, default: '' },
    timezone: { type: 'text', notNull: true },
    start_at: { type: 'text', notNull: true },
    end_at: { type: 'text', notNull: true },
    local_start: { type: 'text', notNull: true },
    local_end: { type: 'text', notNull: true },
    all_day: { type: 'integer', notNull: true, default: 0 },
    request_rsvp: { type: 'integer', notNull: true, default: 1 },
    show_as: { type: 'text', notNull: true, default: 'busy' },
    conversation_id: { type: 'integer', references: 'dm_conversations', onDelete: 'SET NULL' },
    created_by: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    series_id: { type: 'text', notNull: true },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
    meet_code: { type: 'text', references: 'meet_links', onDelete: 'SET NULL' },
  });

  // Meeting attendees
  pgm.createTable('meeting_attendees', {
    meeting_id: { type: 'integer', notNull: true, references: 'meetings', onDelete: 'CASCADE' },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    response: { type: 'text', notNull: true, default: 'pending' },
  }, { primaryKey: ['meeting_id', 'user_id'] });

  // AI messages
  pgm.createTable('ai_messages', {
    id: 'id',
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });

  // Calendar events
  pgm.createTable('calendar_events', {
    id: 'id',
    team_id: { type: 'integer', notNull: true, references: 'teams', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true },
    description: { type: 'text' },
    location: { type: 'text' },
    start_at: { type: 'text', notNull: true },
    end_at: { type: 'text', notNull: true },
    all_day: { type: 'integer', notNull: true, default: 0 },
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
    updated_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });

  // Indexes for performance
  pgm.createIndex('messages', 'channel_id');
  pgm.createIndex('messages', 'conversation_id');
  pgm.createIndex('messages', 'user_id');
  pgm.createIndex('messages', 'parent_message_id');
  pgm.createIndex('messages', 'created_at');
  pgm.createIndex('messages', ['channel_id', 'parent_message_id']);
  pgm.createIndex('dm_participants', 'user_id');
  pgm.createIndex('notifications', 'user_id');
  pgm.createIndex('notifications', 'is_read');
  pgm.createIndex('team_members', 'user_id');
  pgm.createIndex('channel_members', 'user_id');
  pgm.createIndex('attachments', 'message_id');
};

exports.down = async (pgm) => {
  pgm.dropTable('calendar_events');
  pgm.dropTable('ai_messages');
  pgm.dropTable('meeting_attendees');
  pgm.dropTable('meetings');
  pgm.dropTable('meet_links');
  pgm.dropTable('notifications');
  pgm.dropTable('attachments');
  pgm.dropTable('message_reactions');
  pgm.dropTable('blocked_users');
  pgm.dropTable('scheduled_messages');
  pgm.dropTable('messages');
  pgm.dropTable('chat_reports');
  pgm.dropTable('dm_participants');
  pgm.dropTable('dm_conversations');
  pgm.dropTable('channel_members');
  pgm.dropTable('channels');
  pgm.dropTable('team_members');
  pgm.dropTable('team_join_requests');
  pgm.dropTable('teams');
  pgm.dropTable('users');
};