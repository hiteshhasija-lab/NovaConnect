(function () {
  'use strict';
  const NC = window.__NC__;
  const AVATAR_PALETTE = ['#0f766e', '#155e75', '#8a651f', '#426960', '#35627c', '#5c6e42', '#725c4d'];
  const STATUS_LABELS = { online: 'Available', away: 'Appear away', brb: 'Be right back', busy: 'Busy', dnd: 'Do not disturb', offline: 'Appear offline' };

  const state = {
    view: NC.active?.type === 'dm' ? 'chat' : 'teams',
    teams: NC.teams || [],
    conversations: NC.conversations || [],
    active: NC.active || { type: 'none' },
    openTeams: new Set(),
    mentionMembers: [],
    unreadDm: new Set(),
    unreadChannel: new Set(),
    presence: {},
    typingUsers: {},
    threadOpenFor: null,
    mentionState: null,
    aiMessages: null,
    aiLoaded: false,
    calendarMonth: (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })(),
    calendarEvents: [],
    calendarHiddenTeams: new Set()
  };

  // ---------------- helpers ----------------
  function avatarColor(id) { return AVATAR_PALETTE[(Number(id) || 0) % AVATAR_PALETTE.length]; }
  function initials(name) {
    if (!name) return '';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toDate(s) { return new Date(s.replace(' ', 'T') + 'Z'); }
  function fmtTime(s) { return toDate(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function fmtDayLabel(s) {
    const d = toDate(s), now = new Date();
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(d, now)) return 'Today';
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  function renderBody(body, members) {
    let html = escapeHtml(body);
    const sorted = [...(members || [])].sort((a, b) => b.full_name.length - a.full_name.length);
    for (const m of sorted) {
      const needle = escapeHtml('@' + m.full_name);
      if (needle.length < 2) continue;
      html = html.split(needle).join('<span class="mention">' + needle + '</span>');
    }
    return html.replace(/\n/g, '<br>');
  }
  function avatarHtml(user, size) {
    const style = 'background:' + avatarColor(user.id) + (size ? ';width:' + size + ';height:' + size : '');
    return '<span class="user-avatar" style="' + style + '">' + initials(user.full_name) + '</span>';
  }
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function api(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(url, opts).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Something went wrong.');
      return data;
    });
  }

  const channelTools = createChannelTools({ api, escapeHtml, presence:id=>state.presence[id], notify:showToastError, navigate:navigateToChannel, events:teamId=>{
    state.calendarHiddenTeams = new Set(state.teams.filter(t=>t.id!==teamId).map(t=>t.id));
    document.getElementById('railCalendar').click();
  }});
  let channelTabRequest=0, currentChannelTab='posts';
  async function showChannelTab(tab) {
    currentChannelTab=tab;
    const request=++channelTabRequest, id=state.active.channel?.id;
    if(tab==='posts') { renderMessages(state.active.messages||[]);document.getElementById('composer').classList.remove('d-none');return; }
    closeThread();document.getElementById('composer').classList.add('d-none');
    const list=document.getElementById('messageList');list.textContent='Loading…';
    try {
      const assets=[];let before='';
      while(true) {const page=await api('/api/channels/'+id+'/assets'+before);if(request!==channelTabRequest||state.active.channel?.id!==id)return;assets.push(...page);if(page.length<100)break;before='?before='+page[page.length-1].id;}
      list.innerHTML='<div class="channel-assets"></div>';const box=list.firstChild;
      const filtered=assets.filter(a=>tab==='files'||String(a.mime_type).startsWith('image/'));
      if(!filtered.length)box.textContent=tab==='photos'?'No photos shared yet.':'No files shared yet.';
      filtered.forEach(a=>box.append(el(attachmentHtml(a))));
    } catch(e) {if(request===channelTabRequest){list.textContent='Unable to load files.';showToastError(e)}}
  }

  function findChannel(id) {
    id = Number(id);
    for (const t of state.teams) { const c = (t.channels || []).find(c => c.id === id); if (c) return { channel: c, team: t }; }
    return null;
  }
  function findConversation(id) {
    id = Number(id);
    return state.conversations.find(c => c.id === id);
  }
  function convoTitle(c) {
    if (c.name) return c.name;
    const names = (c.participants || []).map(p => p.full_name);
    return names.join(', ') || 'Conversation';
  }

  // ---------------- socket ----------------
  const socket = io({ withCredentials: true });
  const calls = window.createNovaCalls(socket, showToastError);
  const meetings = window.createMeetings({ api, currentUser: NC.currentUser, onSaved: () => { if (state.view === 'calendar') renderCalendarGrid(); if (state.view === 'meet') meetHub.refresh(); api('/api/dm').then(list=>{state.conversations=list;if(state.view==='chat')renderSidebar();}).catch(showToastError); } });
  const meetHub=createMeetHub({api,meetings,escapeHtml,calendar:()=>document.getElementById('railCalendar').click()});
  const chatHeader = window.createChatHeader({ api, currentUser: NC.currentUser, calls, navigate: navigateToDm, preferences: saveChatPreferences, removed: removeChatFromView, meetings, notify: showToastError });
  const chatList=createChatList({escapeHtml,avatarHtml,currentUser:NC.currentUser,presence:id=>state.presence[id],onOpen:navigateToDm,onNew:openNewChatModal,onMeet:()=>document.getElementById('railMeet').click(),onMenu:async(button,c)=>{try{const active=await api('/api/dm/'+c.id);if(button.isConnected)chatHeader.menu(button,active);}catch(e){showToastError(e)}}});
  function applyChatPreferences(id, values) {
    const c = findConversation(id); if (c) Object.assign(c, values);
    if (values.is_unread !== undefined) { if (values.is_unread) state.unreadDm.add(id); else state.unreadDm.delete(id); }
    if (state.active.type === 'dm' && Number(state.active.conversation.id) === Number(id)) Object.assign(state.active.conversation, values);
    renderSidebar();
  }
  async function saveChatPreferences(id, values) {
    const prefs = await api('/api/dm/' + id + '/preferences', { method:'PATCH', body:values });
    applyChatPreferences(id, prefs);
  }
  function removeChatFromView(id) {
    if (state.active.type === 'dm' && Number(state.active.conversation.id) === Number(id)) { state.active = { type:'none' }; history.pushState({}, '', '/app'); renderAll(); }
  }
  socket.on('membership:changed', () => api('/api/teams').then(async teams => { state.teams = await Promise.all(teams.filter(t=>t.is_member).map(async t=>{const data=await api('/api/teams/'+t.id);return {...data.team,channels:data.channels};}));renderSidebar(); }).catch(showToastError));
  socket.on('dm:created', () => api('/api/dm').then(list => { state.conversations = list; renderSidebar(); }).catch(showToastError));
  socket.on('dm:preferences', p => { applyChatPreferences(p.id, p); if (p.is_hidden) removeChatFromView(p.id); });
  document.addEventListener('keydown', e => {
    if (state.active.type !== 'dm' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); window.open('/app/dm/' + state.active.conversation.id, '_blank', 'noopener,noreferrer,width=1150,height=850'); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e' && !state.active.conversation.is_group) { e.preventDefault(); calls.share(state.active.conversation.id, state.active.participants.find(p => p.id !== NC.currentUser.id).full_name); }
  });
  socket.on('message:new', (msg) => {
    if (state.active.type === 'channel' && msg.channel_id === state.active.channel.id) {
      if (currentChannelTab === 'posts') appendMessageToList(msg);
      else state.active.messages.push(msg);
    } else if (state.active.type === 'dm' && msg.conversation_id === state.active.conversation.id) {
      appendMessageToList(msg);
      saveChatPreferences(msg.conversation_id, { is_unread:false }).catch(showToastError);
    } else {
      if (msg.channel_id) state.unreadChannel.add(msg.channel_id);
      if (msg.conversation_id && !findConversation(msg.conversation_id)?.is_muted) state.unreadDm.add(msg.conversation_id);
      renderSidebar();
    }
    bumpConversationPreview(msg);
  });
  socket.on('message:update', (msg) => { patchMessageInList(msg); });
  socket.on('message:delete', (payload) => { markDeletedInList(payload.id); });
  socket.on('thread:message', (msg) => {
    bumpReplyCount(msg.parent_message_id, msg.id);
    if (state.threadOpenFor === msg.parent_message_id) appendThreadReply(msg);
  });
  socket.on('thread:message:update', (msg) => { if (state.threadOpenFor === msg.parent_message_id) patchThreadReply(msg); });
  socket.on('thread:message:delete', (payload) => { if (state.threadOpenFor === payload.parent_message_id) markThreadReplyDeleted(payload.id); });
  socket.on('reaction:update', (payload) => {
    updateReactionsInDom(payload.message_id, payload.reactions);
  });
  socket.on('notification:new', () => {
    api('/api/notifications').then(d => { updateActivityBadge(d.unread_count); if (state.view === 'activity') loadActivity(); });
  });
  socket.on('presence:update', (payload) => {
    state.presence[payload.userId] = payload.status;
    if(payload.userId===NC.currentUser.id){const dot=document.getElementById('myPresenceDot');dot.className='presence-dot presence-'+payload.status;dot.title=STATUS_LABELS[payload.status]||'Offline';}
    document.querySelectorAll('.presence-live-' + payload.userId).forEach(node => {
      node.className = node.className.replace(/presence-(online|away|brb|busy|dnd|offline)/, 'presence-' + payload.status);
      if(node.classList.contains('member-presence')||node.classList.contains('people-presence')) { node.title=STATUS_LABELS[payload.status]||'Offline';node.setAttribute('aria-label',node.title); }
    });
    if (state.active.type === 'dm') {
      const others = state.active.participants.filter(p => p.id !== NC.currentUser.id);
      const label = document.querySelector('#mainHeader .main-header-sub');
      if (others.length === 1 && others[0].id === payload.userId && label) label.textContent = STATUS_LABELS[payload.status] || 'Offline';
    }
  });
  socket.on('typing', (payload) => {
    const key = payload.scope + ':' + payload.id;
    const isActive = (state.active.type === 'channel' && payload.scope === 'channel' && state.active.channel.id === payload.id)
      || (state.active.type === 'dm' && payload.scope === 'dm' && state.active.conversation.id === payload.id);
    if (!isActive) return;
    state.typingUsers[payload.userId] = { name: payload.fullName, at: Date.now() };
    renderTyping();
    clearTimeout(state.typingUsers[payload.userId].timer);
    state.typingUsers[payload.userId].timer = setTimeout(() => { delete state.typingUsers[payload.userId]; renderTyping(); }, 3000);
  });

  function renderTyping() {
    const names = Object.values(state.typingUsers).map(t => t.name);
    const box = document.getElementById('typingIndicator');
    if (names.length === 0) { box.classList.add('d-none'); box.textContent = ''; return; }
    box.classList.remove('d-none');
    box.textContent = names.join(', ') + (names.length === 1 ? ' is typing…' : ' are typing…');
  }

  function bumpConversationPreview(msg) {
    if (msg.conversation_id) {
      const c = findConversation(msg.conversation_id);
      if (c) { c.last_message = msg; c.is_hidden = 0; }
      if (state.view === 'chat') renderSidebar();
    }
  }
  const countedReplyIds = new Set();
  function bumpReplyCount(parentId, replyId) {
    // A reply posted by this tab reaches here twice: once from the POST response, once from
    // the socket echo (the sender's own socket is already in the room). Count each reply once.
    if (replyId != null) {
      if (countedReplyIds.has(replyId)) return;
      countedReplyIds.add(replyId);
    }
    const row = document.querySelector('.msg-row[data-id="' + parentId + '"] .thread-link');
    if (row) {
      const n = (Number(row.dataset.count) || 0) + 1;
      row.dataset.count = n;
      row.innerHTML = '<i class="bi bi-chat-square-text"></i> ' + n + (n === 1 ? ' reply' : ' replies');
    }
  }

  // ---------------- rail / sidebar ----------------
  document.querySelectorAll('.rail-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.view = btn.dataset.view;
      closeAiPane();
      closeCalendarPane();
      meetHub.close();
      if (state.view === 'meet') { closeThread();document.getElementById('sidebar').classList.add('d-none');for(const id of ['mainHeader','messageList','composer'])document.getElementById(id).classList.add('d-none');meetHub.open(); }
      else if (state.view === 'ai') { openAiPane(); }
      else if (state.view === 'calendar') { openCalendarPane(); renderSidebar(); }
      else { renderSidebar(); }
    });
  });

  // ---------------- Gemini ----------------
  const AI_SUGGESTIONS = ['Draft a message', 'Summarize this for me', 'Brainstorm ideas', 'Help me write an update'];
  // A drawn approximation of Gemini's sparkle mark (not Google's actual logo asset —
  // we don't have that file, and reusing another company's exact trademark here would
  // wrongly imply affiliation). Solid currentColor so it tints via surrounding CSS.
  const GEMINI_MARK_SVG = '<svg viewBox="0 0 32 32" width="1em" height="1em" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="vertical-align:-0.15em" aria-hidden="true"><path d="M16 1 Q18.8 13.2 31 16 Q18.8 18.8 16 31 Q13.2 18.8 1 16 Q13.2 13.2 16 1 Z"/></svg>';

  function openAiPane() {
    closeThread();
    document.getElementById('sidebar').classList.add('d-none');
    document.getElementById('mainHeader').classList.add('d-none');
    document.getElementById('messageList').classList.add('d-none');
    document.getElementById('composer').classList.add('d-none');
    document.getElementById('aiPane').classList.remove('d-none');
    if (!state.aiLoaded) {
      api('/api/ai/messages').then(({ messages }) => {
        state.aiMessages = messages;
        state.aiLoaded = true;
        renderAiMessages();
      });
    } else {
      renderAiMessages();
    }
  }
  function closeAiPane() {
    document.getElementById('sidebar').classList.remove('d-none');
    document.getElementById('mainHeader').classList.remove('d-none');
    document.getElementById('messageList').classList.remove('d-none');
    document.getElementById('aiPane').classList.add('d-none');
    document.getElementById('composer').classList.toggle('d-none', state.active.type === 'none');
  }

  function renderAiMessages() {
    const list = document.getElementById('aiMessageList');
    list.innerHTML = '';
    if (!state.aiMessages || state.aiMessages.length === 0) {
      const empty = el(
        '<div class="ai-empty-state">' +
          '<div class="ai-empty-mark">' + GEMINI_MARK_SVG + '</div>' +
          '<h3>Meet Gemini</h3>' +
          '<p>Your private assistant for brainstorming, drafting messages, and quick questions. No one else can see this conversation.</p>' +
          '<div class="ai-suggestion-row"></div>' +
        '</div>'
      );
      const row = empty.querySelector('.ai-suggestion-row');
      AI_SUGGESTIONS.forEach(s => {
        const chip = el('<button type="button" class="ai-suggestion-chip">' + escapeHtml(s) + '</button>');
        chip.addEventListener('click', () => { document.getElementById('aiComposerInput').value = s; sendAiMessage(); });
        row.appendChild(chip);
      });
      list.appendChild(empty);
      return;
    }
    state.aiMessages.forEach(m => list.appendChild(buildAiMessageRow(m)));
    list.scrollTop = list.scrollHeight;
  }

  // Gemini replies naturally in markdown (**bold**, numbered lists) — render just enough
  // of it to not show raw asterisks, without pulling in a full markdown library for this.
  function renderAiBody(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|\s)\*(?!\*)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
    return html;
  }

  function buildAiMessageRow(m) {
    return el(
      '<div class="ai-msg-row role-' + m.role + '">' +
        '<div class="ai-msg-avatar">' + (m.role === 'assistant' ? GEMINI_MARK_SVG : initials(NC.currentUser.full_name)) + '</div>' +
        '<div class="ai-msg-bubble">' + (m.role === 'assistant' ? renderAiBody(m.body) : escapeHtml(m.body)) + '</div>' +
      '</div>'
    );
  }

  const aiInput = document.getElementById('aiComposerInput');
  aiInput.addEventListener('input', () => { aiInput.style.height = 'auto'; aiInput.style.height = Math.min(aiInput.scrollHeight, 128) + 'px'; });
  aiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiMessage(); } });
  document.getElementById('aiSendBtn').addEventListener('click', sendAiMessage);
  document.getElementById('aiNewChatBtn').addEventListener('click', () => {
    if (!confirm('Start a new chat? This clears your current conversation with Gemini.')) return;
    api('/api/ai/clear', { method: 'POST' }).then(() => { state.aiMessages = []; renderAiMessages(); });
  });

  function sendAiMessage() {
    const body = aiInput.value.trim();
    if (!body) return;
    aiInput.value = ''; aiInput.style.height = 'auto';
    if (!state.aiMessages) state.aiMessages = [];
    const list = document.getElementById('aiMessageList');
    if (state.aiMessages.length === 0) list.innerHTML = '';
    const pending = { role: 'user', body };
    state.aiMessages.push(pending);
    list.appendChild(buildAiMessageRow(pending));
    list.scrollTop = list.scrollHeight;

    api('/api/ai/messages', { method: 'POST', body: { body } }).then(({ assistantMessage }) => {
      state.aiMessages.push(assistantMessage);
      list.appendChild(buildAiMessageRow(assistantMessage));
      list.scrollTop = list.scrollHeight;
    }).catch(showToastError);
  }

  function renderSidebar() {
    const title = document.getElementById('sidebarTitle');
    const actions = document.getElementById('sidebarActions');
    const body = document.getElementById('sidebarBody');
    body.innerHTML = '';
    actions.innerHTML = '';

    if (state.view === 'people') {
      title.textContent='People';
      const input=el('<input class="people-search" type="search" aria-label="Search people" placeholder="Name, username or email">');
      const results=el('<div aria-live="polite"></div>');body.append(input,results);
      let timer,generation=0;
      const search=async()=>{const g=++generation;try{const users=await api('/api/users/search?q='+encodeURIComponent(input.value.trim()));if(g!==generation||!results.isConnected)return;results.textContent=users.length?'':'No people found.';users.forEach(u=>{const row=el('<button type="button" class="people-result">'+avatarHtml(u)+'<span class="people-presence presence-'+(state.presence[u.id]||u.status||'offline')+' presence-live-'+u.id+'" role="img" aria-label="'+escapeHtml(STATUS_LABELS[state.presence[u.id]||u.status]||'Appear offline')+'" title="'+escapeHtml(STATUS_LABELS[state.presence[u.id]||u.status]||'Appear offline')+'"></span><span>'+escapeHtml(u.full_name)+'<small>@'+escapeHtml(u.username)+'</small></span></button>');row.onclick=()=>api('/api/dm',{method:'POST',body:{user_ids:[u.id]}}).then(({id})=>navigateToDm(id)).catch(showToastError);results.append(row)});}catch(e){showToastError(e)}};
      input.oninput=()=>{++generation;clearTimeout(timer);timer=setTimeout(search,200)};search();
    } else if (state.view === 'teams') {
      title.textContent = 'Teams';
      const addBtn = el('<button title="Join or create a team"><i class="bi bi-plus-lg"></i></button>');
      addBtn.addEventListener('click', openTeamsModal);
      actions.appendChild(addBtn);

      if (state.teams.length === 0) {
        body.appendChild(el('<div class="p-3 text-muted small">You are not on any teams yet. Use + to join or create one.</div>'));
      }
      state.teams.forEach(team => {
        const isOpen = state.openTeams.has(team.id) || (state.active.type === 'channel' && state.active.team && state.active.team.id === team.id);
        if (isOpen) state.openTeams.add(team.id);
        const group = el(
          '<div class="team-group ' + (isOpen ? 'open' : '') + '" data-team-id="' + team.id + '">' +
            '<div class="team-group-header">' +
              '<i class="bi bi-chevron-right"></i>' +
              '<span class="team-icon"><i class="bi ' + escapeHtml(team.icon || 'bi-people-fill') + '"></i></span>' +
              '<span class="flex-grow-1 text-truncate">' + escapeHtml(team.name) + '</span>' +
              '<button type="button" class="team-members-btn scope-delete-btn" title="Manage team members" aria-label="Manage team members"><i class="bi bi-people"></i></button>' +
            '</div>' +
            '<div class="team-channels"></div>' +
          '</div>'
        );
        group.querySelector('.team-group-header').addEventListener('click', (e) => {
          if (e.target.closest('.team-members-btn')) { e.stopPropagation(); openMembersModal(team.id); return; }
          group.classList.toggle('open');
          if (group.classList.contains('open')) state.openTeams.add(team.id); else state.openTeams.delete(team.id);
        });
        addDeleteControl(group.querySelector('.team-group-header'), team);
        const chanBox = group.querySelector('.team-channels');
        (team.channels || []).forEach(ch => {
          const active = state.active.type === 'channel' && state.active.channel.id === ch.id;
          const unread = state.unreadChannel.has(ch.id);
          const item = el(
            '<div class="channel-item ' + (active ? 'active' : '') + '" data-channel-id="' + ch.id + '">' +
              '<i class="bi ' + (ch.is_private ? 'bi-lock-fill' : 'bi-hash') + '"></i>' +
              '<span class="text-truncate">' + escapeHtml(ch.name) + '</span>' +
              (unread ? '<span class="dm-unread-badge">•</span>' : '') +
            '</div>'
          );
          item.addEventListener('click', () => { state.unreadChannel.delete(ch.id); navigateToChannel(ch.id); });
          addDeleteControl(item, team, ch);
          chanBox.appendChild(item);
        });
        const addChannel = el('<div class="add-item"><i class="bi bi-plus-lg"></i><span>Add channel</span></div>');
        addChannel.addEventListener('click', () => openChannelModal(team.id));
        chanBox.appendChild(addChannel);
        body.appendChild(group);
      });
    }

    if (state.view === 'chat') {
      chatList.render({title,actions,body,conversations:state.conversations,activeId:state.active.type==='dm'?state.active.conversation.id:null,unread:state.unreadDm});
    }

    if (state.view === 'activity') {
      title.textContent = 'Activity';
      const markBtn = el('<button title="Mark all read"><i class="bi bi-check2-all"></i></button>');
      markBtn.addEventListener('click', () => api('/api/notifications/read-all', { method: 'POST' }).then(loadActivity));
      actions.appendChild(markBtn);
      loadActivity();
    }

    if (state.view === 'calendar') {
      title.textContent = 'Calendar';
      if (state.teams.length === 0) {
        body.appendChild(el('<div class="p-3 text-muted small">Join a team to see and create events.</div>'));
      }
      state.teams.forEach(team => {
        const hidden = state.calendarHiddenTeams.has(team.id);
        const row = el(
          '<label class="calendar-legend-item">' +
            '<input type="checkbox" ' + (hidden ? '' : 'checked') + '>' +
            '<span class="calendar-legend-swatch" style="background:' + avatarColor(team.id) + '"></span>' +
            '<span class="text-truncate">' + escapeHtml(team.name) + '</span>' +
          '</label>'
        );
        row.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) state.calendarHiddenTeams.delete(team.id);
          else state.calendarHiddenTeams.add(team.id);
          paintCalendarGrid((() => { const d = new Date(state.calendarMonth); d.setDate(d.getDate() - d.getDay()); return d; })(), state.calendarMonth);
        });
        body.appendChild(row);
      });
    }
  }

  function loadActivity() {
    const body = document.getElementById('sidebarBody');
    api('/api/notifications').then(({ notifications, unread_count }) => {
      updateActivityBadge(unread_count);
      body.innerHTML = '';
      if (notifications.length === 0) {
        body.appendChild(el('<div class="p-3 text-muted small">You\'re all caught up.</div>'));
        return;
      }
      notifications.forEach(n => {
        const item = el(
          '<div class="activity-item ' + (n.is_read ? '' : 'unread') + '">' +
            avatarHtml({ id: n.actor_id, full_name: n.actor_name || '?' }) +
            '<div class="flex-grow-1">' +
              '<div><strong>' + escapeHtml(n.actor_name || 'Someone') + '</strong>' + (n.type === 'meeting' ? ' invited you to a meeting' : ' mentioned you') + (n.channel_name ? ' in #' + escapeHtml(n.channel_name) : '') + '</div>' +
              '<div class="text-muted text-truncate">' + escapeHtml(n.body || '') + '</div>' +
            '</div>' +
          '</div>'
        );
        item.addEventListener('click', () => {
          api('/api/notifications/' + n.id + '/read', { method: 'POST' }).then(loadActivity);
          if (n.channel_id) navigateToChannel(n.channel_id);
          else if (n.type === 'meeting' && n.meeting_id) meetings.show(n.meeting_id);
          else if (n.conversation_id) navigateToDm(n.conversation_id);
        });
        body.appendChild(item);
      });
    });
  }

  function updateActivityBadge(count) {
    const badge = document.getElementById('activityBadge');
    if (count > 0) { badge.textContent = count > 99 ? '99+' : count; badge.classList.remove('d-none'); }
    else badge.classList.add('d-none');
  }
  api('/api/notifications').then(d => updateActivityBadge(d.unread_count)).catch(() => {});

  // ---------------- navigation ----------------
  function navigateToChannel(id) {
    api('/api/channels/' + id).then(({ channel, members }) => {
      return api('/api/channels/' + id + '/messages').then(({ messages }) => {
        const teamEntry = findChannel(id);
        ++channelTabRequest; currentChannelTab='posts';
        if (findChannel(id)) Object.assign(findChannel(id).channel, channel);
        state.active = { type: 'channel', channel, team: teamEntry ? teamEntry.team : { id: channel.team_id }, messages, members };
        state.mentionMembers = members;
        history.pushState({}, '', '/app/channel/' + id);
        renderAll();
      });
    }).catch(showToastError);
  }
  function navigateToDm(id) {
    Promise.all([api('/api/dm/' + id), api('/api/dm/' + id + '/messages')]).then(([{ conversation, participants }, { messages }]) => {
      state.view = 'chat'; meetHub.close(); closeAiPane(); closeCalendarPane();
      document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'chat'));
      state.active = { type: 'dm', conversation, participants, messages };
      saveChatPreferences(conversation.id, { is_unread:false, is_hidden:false }).catch(showToastError);
      state.mentionMembers = participants;
      if (!findConversation(id)) state.conversations.unshift({ ...conversation, participants: participants.filter(p => p.id !== NC.currentUser.id) });
      history.pushState({}, '', '/app/dm/' + id);
      renderAll();
    }).catch(showToastError);
  }
  window.addEventListener('popstate', () => {
    const m = location.pathname.match(/^\/app\/(channel|dm)\/(\d+)/);
    if (m) { if (m[1] === 'channel') navigateToChannel(m[2]); else navigateToDm(m[2]); }
  });

  function showToastError(e) { alert(e.message || 'Something went wrong.'); }

  function renderAll() {
    closeThread();
    renderSidebar();
    renderMainHeader();
    renderMessages(state.active.messages || []);
    document.getElementById('composer').classList.toggle('d-none', state.active.type === 'none');
  }

  function renderMainHeader() {
    chatHeader.close(false);
    const header = document.getElementById('mainHeader');
    if (state.active.type === 'channel') {
      const c = state.active.channel;
      channelTools.header(header, c, tab => showChannelTab(tab));
    } else if (state.active.type === 'dm') {
      const c = state.active.conversation;
      const others = state.active.participants.filter(p => p.id !== NC.currentUser.id);
      const statusText = others.length === 1 ? (STATUS_LABELS[state.presence[others[0].id] || others[0].status] || 'Offline') : others.length + ' people';
      header.innerHTML =
        '<div class="main-header-title"><i class="bi bi-chat-dots"></i>' + escapeHtml(convoTitle({ ...c, participants: others })) +
        '<span class="main-header-sub">' + statusText + '</span></div>';
      chatHeader.render(header, state.active);
    } else {
      header.innerHTML = '<div class="main-header-title text-muted">NovaConnect</div>';
    }
  }

  // ---------------- messages ----------------
  function renderMessages(messages) {
    const list = document.getElementById('messageList');
    list.innerHTML = '';
    if (messages.length === 0) {
      if (state.active.type === 'none') {
        list.appendChild(el('<div class="empty-state"><i class="bi bi-people"></i><div>Select a chat or channel to get started.<br>Use <strong>+</strong> to start a conversation or join a team.</div></div>'));
      } else {
        list.appendChild(el('<div class="empty-state"><i class="bi bi-chat-dots"></i><div>No messages yet — say hi 👋</div></div>'));
      }
      return;
    }
    let lastAuthor = null, lastTime = null, lastDay = null;
    messages.forEach(msg => {
      const day = fmtDayLabel(msg.created_at);
      if (day !== lastDay) { list.appendChild(el('<div class="day-divider"><span>' + day + '</span></div>')); lastAuthor = null; lastDay = day; }
      const grouped = lastAuthor === msg.author.id && (toDate(msg.created_at) - lastTime) < 5 * 60 * 1000;
      list.appendChild(buildMessageRow(msg, grouped));
      lastAuthor = msg.author.id; lastTime = toDate(msg.created_at);
    });
    list.scrollTop = list.scrollHeight;
  }

  function attachmentHtml(a) {
    const isImage = (a.mime_type || '').startsWith('image/');
    const url = '/api/attachments/' + a.id + '/download';
    if (isImage) return '<a href="' + url + '" target="_blank"><img class="msg-attachment-img" src="' + url + '" alt="' + escapeHtml(a.original_name) + '"></a>';
    return '<a class="msg-attachment" href="' + url + '"><i class="bi bi-file-earmark-arrow-down"></i>' + escapeHtml(a.original_name) + '</a>';
  }

  function reactionsHtml(msg) {
    let html = '<div class="msg-reactions">';
    (msg.reactions || []).forEach(r => {
      html += '<span class="reaction-pill ' + (r.mine ? 'mine' : '') + '" data-emoji="' + r.emoji + '">' + r.emoji + ' ' + r.count + '</span>';
    });
    html += '</div>';
    return html;
  }

  const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

  function buildMessageRow(msg, grouped, isThreadReply) {
    const row = el(
      '<div class="msg-row ' + (grouped ? 'grouped' : '') + '" data-id="' + msg.id + '">' +
        (grouped ? '<div class="msg-time-inline">' + fmtTime(msg.created_at) + '</div>' : '<div class="msg-avatar-slot">' + avatarHtml(msg.author) + '</div>') +
        '<div class="msg-body-col">' +
          (grouped ? '' : '<div class="msg-meta"><span class="msg-author">' + escapeHtml(msg.author.full_name) + '</span><span class="msg-time">' + fmtTime(msg.created_at) + '</span></div>') +
          '<div class="msg-content"></div>' +
        '</div>' +
        '<div class="msg-actions">' +
          '<div class="reaction-picker">' + QUICK_EMOJI.map(e => '<button data-emoji="' + e + '" title="React">' + e + '</button>').join('') + '</div>' +
          (msg.author.id === NC.currentUser.id ? '<button class="edit-btn" title="Edit"><i class="bi bi-pencil"></i></button><button class="delete-btn" title="Delete"><i class="bi bi-trash"></i></button>' : '') +
        '</div>' +
      '</div>'
    );
    renderMessageContent(row, msg, isThreadReply);
    row.querySelectorAll('.reaction-picker button').forEach(btn => {
      btn.addEventListener('click', () => api('/api/messages/' + msg.id + '/reactions', { method: 'POST', body: { emoji: btn.dataset.emoji } }));
    });
    const editBtn = row.querySelector('.edit-btn');
    if (editBtn) editBtn.addEventListener('click', () => startEdit(row, msg));
    const deleteBtn = row.querySelector('.delete-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => { if (confirm('Delete this message?')) api('/api/messages/' + msg.id, { method: 'DELETE' }); });
    return row;
  }

  function renderMessageContent(row, msg, isThreadReply) {
    const box = row.querySelector('.msg-content');
    if (msg.deleted) {
      box.innerHTML = '<div class="msg-deleted"><i class="bi bi-slash-circle me-1"></i>This message was deleted</div>';
      return;
    }
    let html = '<div class="msg-text">' + renderBody(msg.body, state.mentionMembers) + (msg.edited ? ' <span class="msg-edited">(edited)</span>' : '') + '</div>';
    if (msg.metadata && msg.metadata.cardType === 'decom_approval') html += decomApprovalCardHtml(msg.metadata);
    (msg.attachments || []).forEach(a => { html += attachmentHtml(a); });
    html += reactionsHtml(msg);
    if (!isThreadReply) {
      html += '<button class="thread-link" data-count="' + (msg.reply_count || 0) + '">' +
        (msg.reply_count ? '<i class="bi bi-chat-square-text"></i> ' + msg.reply_count + (msg.reply_count === 1 ? ' reply' : ' replies') : '<i class="bi bi-chat-square-text"></i> Reply in thread') +
        '</button>';
    }
    box.innerHTML = html;
    if (!isThreadReply) box.querySelector('.thread-link').addEventListener('click', () => openThread(msg.id));
    if (msg.metadata && msg.metadata.cardType === 'decom_approval') wireDecomApprovalCard(box, msg);
  }

  function decomApprovalCardHtml(meta) {
    if (meta.status !== 'pending') {
      const label = meta.status === 'approved' ? 'Approved' : 'Rejected';
      return '<div class="decom-card decom-card-' + meta.status + '"><i class="bi ' + (meta.status === 'approved' ? 'bi-check-circle-fill' : 'bi-x-circle-fill') + '"></i> ' + label + '</div>';
    }
    return (
      '<div class="decom-card decom-card-pending">' +
        '<div class="decom-card-title">' + escapeHtml(meta.changeNumber) + ' — awaiting approval</div>' +
        '<div class="decom-card-actions">' +
          '<button type="button" class="btn btn-sm btn-success decom-approve-btn">Approve</button>' +
          '<button type="button" class="btn btn-sm btn-outline-danger decom-reject-btn">Reject</button>' +
        '</div>' +
      '</div>'
    );
  }

  function wireDecomApprovalCard(box, msg) {
    const card = box.querySelector('.decom-card-pending');
    if (!card) return;
    const setBusy = (busy) => card.querySelectorAll('button').forEach(b => { b.disabled = busy; });
    const act = (action) => {
      setBusy(true);
      api('/api/decom/' + msg.metadata.changeId + '/' + action, { method: 'POST', body: { channel_id: msg.channel_id, message_id: msg.id } })
        .catch(e => { setBusy(false); showToastError(e); });
    };
    card.querySelector('.decom-approve-btn').addEventListener('click', () => act('approve'));
    card.querySelector('.decom-reject-btn').addEventListener('click', () => act('reject'));
  }

  function startEdit(row, msg) {
    const box = row.querySelector('.msg-content');
    const original = box.innerHTML;
    box.innerHTML = '<textarea class="composer-input w-100 mb-1" rows="2">' + escapeHtml(msg.body) + '</textarea>' +
      '<button class="btn btn-sm btn-primary me-1 save-edit">Save</button><button class="btn btn-sm btn-outline-secondary cancel-edit">Cancel</button>';
    const ta = box.querySelector('textarea');
    ta.focus();
    box.querySelector('.cancel-edit').addEventListener('click', () => { box.innerHTML = original; });
    box.querySelector('.save-edit').addEventListener('click', () => {
      api('/api/messages/' + msg.id, { method: 'PUT', body: { body: ta.value } }).catch(showToastError);
    });
  }

  function appendMessageToList(msg) {
    if (document.querySelector('.msg-row[data-id="' + msg.id + '"]')) return;
    const list = document.getElementById('messageList');
    const wasEmpty = !!list.querySelector('.empty-state');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (wasEmpty) list.innerHTML = '';
    const lastRow = [...list.querySelectorAll('.msg-row')].pop();
    let grouped = false;
    if (lastRow) {
      const lastId = Number(lastRow.dataset.id);
      const lastMsg = (state.active.messages || []).find(m => m.id === lastId);
      if (lastMsg && lastMsg.author.id === msg.author.id && (toDate(msg.created_at) - toDate(lastMsg.created_at)) < 5 * 60 * 1000) grouped = true;
    }
    const today = fmtDayLabel(msg.created_at);
    const lastDivider = [...list.querySelectorAll('.day-divider span')].pop();
    if (!lastDivider || lastDivider.textContent !== today) { list.appendChild(el('<div class="day-divider"><span>' + today + '</span></div>')); grouped = false; }
    list.appendChild(buildMessageRow(msg, grouped));
    (state.active.messages = state.active.messages || []).push(msg);
    if (nearBottom || msg.author.id === NC.currentUser.id) list.scrollTop = list.scrollHeight;
  }
  function patchMessageInList(msg) {
    const row = document.querySelector('.msg-row[data-id="' + msg.id + '"]');
    if (row) renderMessageContent(row, msg, false);
    const idx = (state.active.messages || []).findIndex(m => m.id === msg.id);
    if (idx >= 0) state.active.messages[idx] = msg;
  }
  function markDeletedInList(id) {
    const row = document.querySelector('.msg-row[data-id="' + id + '"]');
    if (row) row.querySelector('.msg-content').innerHTML = '<div class="msg-deleted"><i class="bi bi-slash-circle me-1"></i>This message was deleted</div>';
  }
  function updateReactionsInDom(messageId, reactions) {
    const row = document.querySelector('.msg-row[data-id="' + messageId + '"]') || document.querySelector('.thread-replies .msg-row[data-id="' + messageId + '"]') || document.querySelector('#threadParent .msg-row[data-id="' + messageId + '"]');
    if (!row) return;
    const box = row.querySelector('.msg-reactions');
    if (box) box.outerHTML = reactionsHtml({ reactions });
    row.querySelectorAll('.reaction-pill').forEach(p => {
      p.addEventListener('click', () => api('/api/messages/' + messageId + '/reactions', { method: 'POST', body: { emoji: p.dataset.emoji } }));
    });
  }

  document.getElementById('messageList').addEventListener('scroll', function () {
    if (this.scrollTop < 60 && state.active.type !== 'none' && (state.active.messages || []).length >= 50) {
      loadOlderMessages();
    }
  });
  let loadingOlder = false;
  function loadOlderMessages() {
    if (loadingOlder) return;
    const oldest = state.active.messages[0];
    if (!oldest) return;
    loadingOlder = true;
    const base = state.active.type === 'channel' ? '/api/channels/' + state.active.channel.id : '/api/dm/' + state.active.conversation.id;
    api(base + '/messages?before=' + oldest.id).then(({ messages }) => {
      loadingOlder = false;
      if (messages.length === 0) return;
      const list = document.getElementById('messageList');
      const prevHeight = list.scrollHeight;
      state.active.messages = messages.concat(state.active.messages);
      renderMessages(state.active.messages);
      list.scrollTop = list.scrollHeight - prevHeight;
    }).catch(() => { loadingOlder = false; });
  }

  // ---------------- composer ----------------
  const composerInput = document.getElementById('composerInput');
  const composerFileInput = document.getElementById('composerFileInput');
  const composerFilePreview = document.getElementById('composerFilePreview');
  let pendingFile = null;

  composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, 128) + 'px';
    handleMentionTyping(composerInput, document.getElementById('mentionPopover'));
    emitTyping();
  });
  composerInput.addEventListener('keydown', (e) => {
    if (handleMentionKeydown(e, composerInput, document.getElementById('mentionPopover'))) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComposerMessage(); }
  });
  composerFileInput.addEventListener('change', () => {
    pendingFile = composerFileInput.files[0] || null;
    if (pendingFile) {
      composerFilePreview.classList.remove('d-none');
      composerFilePreview.innerHTML = '<i class="bi bi-paperclip"></i> ' + escapeHtml(pendingFile.name) + '<button><i class="bi bi-x"></i></button>';
      composerFilePreview.querySelector('button').addEventListener('click', () => { pendingFile = null; composerFileInput.value = ''; composerFilePreview.classList.add('d-none'); });
    }
  });
  document.getElementById('composerSendBtn').addEventListener('click', sendComposerMessage);

  // ---------------- rewrite with Gemini ----------------
  const rewritePopover = document.getElementById('rewritePopover');
  const REWRITE_STYLE_LABELS = { concise: 'Concise', professional: 'Professional', friendly: 'Friendlier', grammar: 'Fix grammar' };

  document.getElementById('composerWandBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!composerInput.value.trim()) { composerInput.focus(); return; }
    if (!rewritePopover.classList.contains('d-none')) { rewritePopover.classList.add('d-none'); return; }
    showRewriteStylePicker();
  });
  document.addEventListener('click', (e) => {
    if (!rewritePopover.classList.contains('d-none') && !rewritePopover.contains(e.target) && !e.target.closest('#composerWandBtn')) {
      rewritePopover.classList.add('d-none');
    }
  });

  function rewriteLabel() { return '<div class="rewrite-popover-label">' + GEMINI_MARK_SVG + ' Rewrite with Gemini</div>'; }

  function showRewriteStylePicker() {
    rewritePopover.innerHTML = rewriteLabel() +
      '<div class="rewrite-style-row">' +
        Object.keys(REWRITE_STYLE_LABELS).map(s => '<button type="button" class="rewrite-style-chip" data-style="' + s + '">' + REWRITE_STYLE_LABELS[s] + '</button>').join('') +
      '</div>';
    rewritePopover.classList.remove('d-none');
    rewritePopover.querySelectorAll('.rewrite-style-chip').forEach(chip => {
      // stopPropagation matters here: this handler replaces rewritePopover's innerHTML
      // (destroying `chip` itself), and if the click then bubbles to the document-level
      // outside-click listener, `rewritePopover.contains(e.target)` checks against a node
      // that's already detached — reading as "outside" and closing the popover we just opened.
      chip.addEventListener('click', (e) => { e.stopPropagation(); runRewrite(chip.dataset.style); });
    });
  }

  function runRewrite(style) {
    const original = composerInput.value;
    rewritePopover.innerHTML = rewriteLabel() + '<div class="rewrite-loading"><span class="spinner-border spinner-border-sm"></span> Rewriting…</div>';
    api('/api/ai/rewrite', { method: 'POST', body: { text: original, style } }).then(({ rewritten }) => {
      rewritePopover.innerHTML = rewriteLabel() +
        '<div class="rewrite-result-text"></div>' +
        '<div class="rewrite-actions">' +
          '<button type="button" class="btn btn-sm btn-outline-secondary" id="rewriteDiscardBtn">Discard</button>' +
          '<button type="button" class="btn btn-sm btn-primary" id="rewriteApplyBtn">Apply</button>' +
        '</div>';
      rewritePopover.querySelector('.rewrite-result-text').textContent = rewritten;
      rewritePopover.querySelector('#rewriteDiscardBtn').addEventListener('click', (e) => { e.stopPropagation(); rewritePopover.classList.add('d-none'); });
      rewritePopover.querySelector('#rewriteApplyBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        composerInput.value = rewritten;
        composerInput.style.height = 'auto';
        composerInput.style.height = Math.min(composerInput.scrollHeight, 128) + 'px';
        rewritePopover.classList.add('d-none');
        composerInput.focus();
      });
    }).catch(e => {
      rewritePopover.innerHTML = rewriteLabel() +
        '<div class="rewrite-error">' + escapeHtml(e.message || 'Something went wrong.') + '</div>' +
        '<div class="rewrite-actions"><button type="button" class="btn btn-sm btn-outline-secondary" id="rewriteCloseBtn">Close</button></div>';
      rewritePopover.querySelector('#rewriteCloseBtn').addEventListener('click', (e2) => { e2.stopPropagation(); rewritePopover.classList.add('d-none'); });
    });
  }

  let typingLast = 0;
  function emitTyping() {
    const now = Date.now();
    if (now - typingLast < 1500) return;
    typingLast = now;
    if (state.active.type === 'channel') socket.emit('typing', { scope: 'channel', id: state.active.channel.id });
    else if (state.active.type === 'dm') socket.emit('typing', { scope: 'dm', id: state.active.conversation.id });
  }

  function sendComposerMessage() {
    const body = composerInput.value.trim();
    if (!body && !pendingFile) return;
    if (state.active.type === 'none') return;
    const fd = new FormData();
    fd.append('body', body);
    if (pendingFile) fd.append('file', pendingFile);
    const url = state.active.type === 'channel' ? '/api/channels/' + state.active.channel.id + '/messages' : '/api/dm/' + state.active.conversation.id + '/messages';
    composerInput.value = ''; composerInput.style.height = 'auto';
    pendingFile = null; composerFileInput.value = ''; composerFilePreview.classList.add('d-none');
    api(url, { method: 'POST', body: fd }).then(msg => appendMessageToList(msg)).catch(showToastError);
  }

  // ---------------- @mentions ----------------
  function handleMentionTyping(input, popover) {
    const val = input.value, pos = input.selectionStart;
    const upToCursor = val.slice(0, pos);
    const m = upToCursor.match(/(^|\s)@([a-zA-Z][\w .]{0,30})$/);
    if (!m) { popover.classList.add('d-none'); state.mentionState = null; return; }
    const query = m[2].toLowerCase();
    const matches = state.mentionMembers.filter(u => u.full_name.toLowerCase().includes(query)).slice(0, 6);
    if (matches.length === 0) { popover.classList.add('d-none'); state.mentionState = null; return; }
    state.mentionState = { matchStart: pos - m[2].length - 1, matches, activeIndex: 0 };
    popover.innerHTML = '';
    matches.forEach((u, i) => {
      const opt = el('<div class="mention-option ' + (i === 0 ? 'active' : '') + '">' + avatarHtml(u) + '<span>' + escapeHtml(u.full_name) + '</span></div>');
      opt.addEventListener('mousedown', (e) => { e.preventDefault(); applyMention(input, popover, u); });
      popover.appendChild(opt);
    });
    popover.classList.remove('d-none');
  }
  function handleMentionKeydown(e, input, popover) {
    if (!state.mentionState) return false;
    const s = state.mentionState;
    if (e.key === 'ArrowDown') { e.preventDefault(); s.activeIndex = (s.activeIndex + 1) % s.matches.length; refreshMentionActive(popover, s); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); s.activeIndex = (s.activeIndex - 1 + s.matches.length) % s.matches.length; refreshMentionActive(popover, s); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(input, popover, s.matches[s.activeIndex]); return true; }
    if (e.key === 'Escape') { popover.classList.add('d-none'); state.mentionState = null; return true; }
    return false;
  }
  function refreshMentionActive(popover, s) {
    [...popover.children].forEach((c, i) => c.classList.toggle('active', i === s.activeIndex));
  }
  function applyMention(input, popover, user) {
    const s = state.mentionState;
    const before = input.value.slice(0, s.matchStart);
    const after = input.value.slice(input.selectionStart);
    input.value = before + '@' + user.full_name + ' ' + after;
    popover.classList.add('d-none');
    state.mentionState = null;
    input.focus();
  }

  // ---------------- threads ----------------
  function openThread(messageId) {
    state.threadOpenFor = messageId;
    document.getElementById('threadPanel').classList.remove('d-none');
    api('/api/messages/' + messageId + '/thread').then(({ parent, replies }) => {
      document.getElementById('threadParent').innerHTML = '';
      document.getElementById('threadParent').appendChild(buildMessageRow(parent, false, true));
      const box = document.getElementById('threadReplies');
      box.innerHTML = '';
      let lastAuthor = null;
      replies.forEach(r => { const grouped = lastAuthor === r.author.id; box.appendChild(buildMessageRow(r, grouped, true)); lastAuthor = r.author.id; });
      box.scrollTop = box.scrollHeight;
    });
  }
  function closeThread() {
    state.threadOpenFor = null;
    document.getElementById('threadPanel').classList.add('d-none');
  }
  document.getElementById('closeThreadBtn').addEventListener('click', closeThread);

  function appendThreadReply(msg) {
    const box = document.getElementById('threadReplies');
    if (box.querySelector('.msg-row[data-id="' + msg.id + '"]')) return;
    box.appendChild(buildMessageRow(msg, false, true));
    box.scrollTop = box.scrollHeight;
  }
  function patchThreadReply(msg) {
    const row = document.querySelector('#threadReplies .msg-row[data-id="' + msg.id + '"]');
    if (row) renderMessageContent(row, msg, true);
  }
  function markThreadReplyDeleted(id) {
    const row = document.querySelector('#threadReplies .msg-row[data-id="' + id + '"]');
    if (row) row.querySelector('.msg-content').innerHTML = '<div class="msg-deleted"><i class="bi bi-slash-circle me-1"></i>This message was deleted</div>';
  }

  const threadInput = document.getElementById('threadComposerInput');
  document.getElementById('threadSendBtn').addEventListener('click', sendThreadReply);
  threadInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendThreadReply(); } });
  function sendThreadReply() {
    const body = threadInput.value.trim();
    if (!body || !state.threadOpenFor) return;
    const fd = new FormData();
    fd.append('body', body);
    fd.append('parent_message_id', state.threadOpenFor);
    const url = state.active.type === 'channel' ? '/api/channels/' + state.active.channel.id + '/messages' : '/api/dm/' + state.active.conversation.id + '/messages';
    threadInput.value = '';
    api(url, { method: 'POST', body: fd }).then(msg => { appendThreadReply(msg); bumpReplyCount(msg.parent_message_id, msg.id); }).catch(showToastError);
  }

  // ---------------- modals: teams / channels / chat / members ----------------
  // Bootstrap's JS bundle loads after this script (see partials/foot), so modal
  // instances are created lazily on first use rather than at parse time.
  function modalOf(el) { return bootstrap.Modal.getOrCreateInstance(el); }
  const teamsModalEl = document.getElementById('teamsModal');
  function openTeamsModal() {
    modalOf(teamsModalEl).show();
    api('/api/teams').then(teams => {
      const box = document.getElementById('browseTeamsList');
      box.innerHTML = '';
      teams.forEach(t => {
        const row = el(
          '<div class="list-group-item d-flex align-items-center justify-content-between">' +
            '<div><div class="fw-semibold"><i class="bi ' + escapeHtml(t.icon || 'bi-people-fill') + '" style="color:var(--brand)"></i> ' + escapeHtml(t.name) + '</div>' +
            '<div class="text-muted small">' + escapeHtml(t.description || '') + ' · ' + t.member_count + ' members</div></div>' +
            (t.is_member ? '<span class="badge text-bg-secondary">Joined</span>' : '<button class="btn btn-sm btn-primary">Join</button>') +
          '</div>'
        );
        if (!t.is_member) {
          row.querySelector('button').addEventListener('click', () => {
            api('/api/teams/' + t.id + '/join', { method: 'POST' }).then(() => api('/api/teams/' + t.id)).then(({ team, channels }) => {
              team.channels = channels;
              state.teams.push(team);
              state.openTeams.add(team.id);
              modalOf(teamsModalEl).hide();
              renderSidebar();
              if (channels[0]) navigateToChannel(channels[0].id);
            });
          });
        } else {
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => {
            const t2 = findTeamLocal(t.id);
            modalOf(teamsModalEl).hide();
            if (t2 && t2.channels[0]) navigateToChannel(t2.channels[0].id);
          });
        }
        box.appendChild(row);
      });
    });
  }
  function applyTeamDeletion({ teamId, channelId }) {
    const team = state.teams.find(t => t.id === teamId);
    const removed = channelId ? [channelId] : (team?.channels || []).map(c => c.id);
    removed.forEach(id => state.unreadChannel.delete(id));
    if (channelId) { if (team) team.channels = team.channels.filter(c => c.id !== channelId); }
    else { state.teams = state.teams.filter(t => t.id !== teamId); state.openTeams.delete(teamId); }
    if (state.active.type === 'channel' && (channelId ? state.active.channel.id === channelId : state.active.channel.team_id === teamId)) {
      state.active = { type: 'none', messages: [] };
      history.replaceState({}, '', '/app');
    }
    renderAll();
  }
  socket.on('team:deleted', applyTeamDeletion);
  socket.on('channel:deleted', applyTeamDeletion);

  function addDeleteControl(container, team, channel) {
    if (!['owner', 'admin'].includes(team.my_role)) return;
    const kind = channel ? 'channel' : 'team';
    const button = el('<button type="button" class="scope-delete-btn" title="Delete ' + kind + '" aria-label="Delete ' + kind + '"><i class="bi bi-trash"></i></button>');
    button.addEventListener('click', async e => {
      e.stopPropagation();
      const name = channel ? '#' + channel.name : team.name;
      const consequence = channel ? 'This permanently deletes its messages and shared file records.' : 'This permanently deletes all its channels, messages, shared file records, and team calendar events.';
      if (!window.confirm('Delete ' + kind + ' “' + name + '”? ' + consequence + ' This cannot be undone.')) return;
      button.disabled = true;
      try {
        await api('/api/' + (channel ? 'channels/' + channel.id : 'teams/' + team.id), { method: 'DELETE' });
        applyTeamDeletion({ teamId: team.id, ...(channel ? { channelId: channel.id } : {}) });
      } catch (error) { button.disabled = false; showToastError(error); }
    });
    container.appendChild(button);
  }

  function findTeamLocal(id) { return state.teams.find(t => t.id === id); }

  document.getElementById('createTeamForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    api('/api/teams', { method: 'POST', body: { name: fd.get('name'), description: fd.get('description') } }).then(({ team, channel }) => {
      team.channels = [channel];
      state.teams.push(team);
      state.openTeams.add(team.id);
      modalOf(teamsModalEl).hide();
      e.target.reset();
      navigateToChannel(channel.id);
    }).catch(showToastError);
  });

  const channelModalEl = document.getElementById('channelModal');
  let channelModalTeamId = null;
  function openChannelModal(teamId) { channelModalTeamId = teamId; modalOf(channelModalEl).show(); }
  document.getElementById('createChannelForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    api('/api/teams/' + channelModalTeamId + '/channels', { method: 'POST', body: { name: fd.get('name'), description: fd.get('description'), is_private: fd.get('is_private') ? 1 : 0 } })
      .then(channel => {
        const team = findTeamLocal(channelModalTeamId);
        if (team) { team.channels.push(channel); team.channels.sort((a, b) => a.name.localeCompare(b.name)); state.openTeams.add(team.id); }
        modalOf(channelModalEl).hide();
        e.target.reset();
        navigateToChannel(channel.id);
      }).catch(showToastError);
  });

  const newChatModalEl = document.getElementById('newChatModal');
  let newChatSelected = [];
  function openNewChatModal() {
    newChatSelected = [];
    document.getElementById('newChatSelected').innerHTML = '';
    document.getElementById('newChatResults').innerHTML = '';
    document.getElementById('newChatSearch').value = '';
    document.getElementById('startChatBtn').disabled = true;
    modalOf(newChatModalEl).show();
  }
  let searchDebounce;
  document.getElementById('newChatSearch').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim();
    searchDebounce = setTimeout(() => {
      if (!q) { document.getElementById('newChatResults').innerHTML = ''; return; }
      api('/api/users/search?q=' + encodeURIComponent(q)).then(users => {
        const box = document.getElementById('newChatResults');
        box.innerHTML = '';
        users.filter(u => !newChatSelected.some(s => s.id === u.id)).forEach(u => {
          const row = el('<button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2">' + avatarHtml(u) + '<span>' + escapeHtml(u.full_name) + ' <span class="text-muted">@' + escapeHtml(u.username) + '</span></span></button>');
          row.addEventListener('click', () => {
            newChatSelected.push(u);
            renderNewChatSelected();
            box.innerHTML = '';
          });
          box.appendChild(row);
        });
      });
    }, 200);
  });
  function renderNewChatSelected() {
    const box = document.getElementById('newChatSelected');
    box.innerHTML = '';
    newChatSelected.forEach(u => {
      const pill = el('<span class="user-pill">' + avatarHtml(u) + escapeHtml(u.full_name) + '<button>&times;</button></span>');
      pill.querySelector('button').addEventListener('click', () => { newChatSelected = newChatSelected.filter(s => s.id !== u.id); renderNewChatSelected(); });
      box.appendChild(pill);
    });
    document.getElementById('startChatBtn').disabled = newChatSelected.length === 0;
  }
  document.getElementById('startChatBtn').addEventListener('click', () => {
    api('/api/dm', { method: 'POST', body: { user_ids: newChatSelected.map(u => u.id) } }).then(({ id }) => {
      modalOf(newChatModalEl).hide();
      navigateToDm(id);
    }).catch(showToastError);
  });

  function openMembersModal(teamId) { channelTools.members('teams', teamId); }

  // ---------------- calendar ----------------
  function pad2(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  // datetime-local inputs are local time by construction/interpretation of `new Date(str)`;
  // the API stores/expects naive UTC strings ('YYYY-MM-DD HH:MM:SS'), matching toDate()'s convention.
  function localInputToUtcStr(val) {
    if (!val) return null;
    const d = new Date(val);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  function utcStrToLocalInput(s) {
    const d = toDate(s);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function openCalendarPane() {
    closeThread();
    document.getElementById('mainHeader').classList.add('d-none');
    document.getElementById('messageList').classList.add('d-none');
    document.getElementById('composer').classList.add('d-none');
    document.getElementById('calendarPane').classList.remove('d-none');
    renderCalendarGrid();
  }
  function closeCalendarPane() {
    document.getElementById('mainHeader').classList.remove('d-none');
    document.getElementById('messageList').classList.remove('d-none');
    document.getElementById('calendarPane').classList.add('d-none');
    document.getElementById('composer').classList.toggle('d-none', state.active.type === 'none');
  }

  document.getElementById('calPrevBtn').addEventListener('click', () => {
    state.calendarMonth.setMonth(state.calendarMonth.getMonth() - 1);
    renderCalendarGrid();
  });
  document.getElementById('calNextBtn').addEventListener('click', () => {
    state.calendarMonth.setMonth(state.calendarMonth.getMonth() + 1);
    renderCalendarGrid();
  });
  document.getElementById('calTodayBtn').addEventListener('click', () => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
    state.calendarMonth = d;
    renderCalendarGrid();
  });
  document.getElementById('calNewEventBtn').addEventListener('click', () => openEventModal());

  function renderCalendarGrid() {
    const month = state.calendarMonth;
    document.getElementById('calMonthLabel').textContent = month.toLocaleDateString([], { month: 'long', year: 'numeric' });

    const gridStart = new Date(month.getFullYear(), month.getMonth(), 1);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    const gridEnd = new Date(gridStart);
    gridEnd.setDate(gridEnd.getDate() + 42);

    api('/api/calendar/events?start=' + ymd(gridStart) + '&end=' + ymd(gridEnd)).then(({ events }) => {
      state.calendarEvents = events;
      paintCalendarGrid(gridStart, month);
    }).catch(showToastError);
  }

  function paintCalendarGrid(gridStart, month) {
    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = '';
    const today = new Date();
    const byDay = {};
    state.calendarEvents.forEach(ev => {
      if (state.calendarHiddenTeams.has(ev.team_id)) return;
      const key = ymd(toDate(ev.start_at));
      (byDay[key] = byDay[key] || []).push(ev);
    });

    for (let i = 0; i < 42; i++) {
      const day = new Date(gridStart);
      day.setDate(day.getDate() + i);
      const key = ymd(day);
      const isOtherMonth = day.getMonth() !== month.getMonth();
      const isToday = day.toDateString() === today.toDateString();
      const cell = el(
        '<div class="calendar-day ' + (isOtherMonth ? 'other-month' : '') + ' ' + (isToday ? 'is-today' : '') + '" data-date="' + key + '">' +
          '<div class="calendar-day-num">' + day.getDate() + '</div>' +
          '<div class="calendar-day-events"></div>' +
        '</div>'
      );
      const dayEvents = (byDay[key] || []).sort((a, b) => a.start_at.localeCompare(b.start_at));
      const box = cell.querySelector('.calendar-day-events');
      const VISIBLE = 3;
      dayEvents.slice(0, VISIBLE).forEach(ev => {
        const chip = el(
          '<div class="calendar-event-chip" style="background:' + avatarColor(ev.team_id) + '">' +
            (ev.all_day ? '' : '<span class="calendar-event-time">' + fmtTime(ev.start_at) + '</span> ') +
            escapeHtml(ev.title) +
          '</div>'
        );
        chip.addEventListener('click', (e) => { e.stopPropagation(); openEventModal(ev); });
        box.appendChild(chip);
      });
      if (dayEvents.length > VISIBLE) {
        const more = el('<div class="calendar-more-link">+' + (dayEvents.length - VISIBLE) + ' more</div>');
        more.addEventListener('click', (e) => { e.stopPropagation(); openDayEventsModal(key, dayEvents); });
        box.appendChild(more);
      }
      cell.addEventListener('click', () => openEventModal(null, key));
      grid.appendChild(cell);
    }
  }

  const eventModalEl = document.getElementById('eventModal');
  const eventForm = document.getElementById('eventForm');
  let editingEventId = null;
  function populateEventTeamSelect() {
    const select = document.getElementById('eventTeamSelect');
    select.innerHTML = '';
    state.teams.forEach(t => select.appendChild(el('<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>')));
  }
  function openEventModal(ev, dateKey) {
    if (ev?.meeting_id) { meetings.show(ev.meeting_id); return; }
    populateEventTeamSelect();
    document.getElementById('eventFormError').classList.add('d-none');
    eventForm.reset();
    editingEventId = ev ? ev.id : null;
    document.getElementById('eventModalTitle').innerHTML = '<i class="bi bi-calendar-plus me-2"></i>' + (ev ? 'Edit Event' : 'New Event');
    document.getElementById('eventDeleteBtn').classList.toggle('d-none', !ev);
    if (ev) {
      eventForm.elements.id.value = ev.id;
      eventForm.elements.team_id.value = ev.team_id;
      eventForm.elements.title.value = ev.title;
      eventForm.elements.all_day.checked = !!ev.all_day;
      eventForm.elements.start_at.value = utcStrToLocalInput(ev.start_at);
      eventForm.elements.end_at.value = utcStrToLocalInput(ev.end_at);
      eventForm.elements.location.value = ev.location || '';
      eventForm.elements.description.value = ev.description || '';
    } else {
      const base = dateKey ? new Date(dateKey + 'T09:00') : new Date();
      const end = new Date(base.getTime() + 30 * 60000);
      eventForm.elements.start_at.value = pad2ForInput(base);
      eventForm.elements.end_at.value = pad2ForInput(end);
      if (state.teams[0]) eventForm.elements.team_id.value = state.teams[0].id;
    }
    modalOf(eventModalEl).show();
  }
  function pad2ForInput(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  eventForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(eventForm);
    const payload = {
      team_id: Number(fd.get('team_id')),
      title: fd.get('title'),
      description: fd.get('description'),
      location: fd.get('location'),
      all_day: fd.get('all_day') ? 1 : 0,
      start_at: localInputToUtcStr(fd.get('start_at')),
      end_at: localInputToUtcStr(fd.get('end_at'))
    };
    const errBox = document.getElementById('eventFormError');
    errBox.classList.add('d-none');
    const req = editingEventId
      ? api('/api/calendar/events/' + editingEventId, { method: 'PUT', body: payload })
      : api('/api/calendar/events', { method: 'POST', body: payload });
    req.then(() => {
      modalOf(eventModalEl).hide();
      renderCalendarGrid();
    }).catch(e => { errBox.textContent = e.message; errBox.classList.remove('d-none'); });
  });

  document.getElementById('eventDeleteBtn').addEventListener('click', () => {
    if (!editingEventId) return;
    if (!confirm('Delete this event?')) return;
    api('/api/calendar/events/' + editingEventId, { method: 'DELETE' }).then(() => {
      modalOf(eventModalEl).hide();
      renderCalendarGrid();
    }).catch(showToastError);
  });

  const dayEventsModalEl = document.getElementById('dayEventsModal');
  function openDayEventsModal(dateKey, dayEvents) {
    document.getElementById('dayEventsModalTitle').innerHTML = '<i class="bi bi-calendar3 me-2"></i>' + toDate(dateKey + ' 12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const list = document.getElementById('dayEventsList');
    list.innerHTML = '';
    dayEvents.forEach(ev => {
      const row = el(
        '<button type="button" class="list-group-item list-group-item-action event-detail-row">' +
          '<span class="event-detail-swatch" style="background:' + avatarColor(ev.team_id) + '"></span>' +
          '<div class="flex-grow-1 min-w-0">' +
            '<div class="text-truncate">' + escapeHtml(ev.title) + '</div>' +
            '<div class="event-detail-time text-muted">' + (ev.all_day ? 'All day' : fmtTime(ev.start_at) + ' – ' + fmtTime(ev.end_at)) + ' · ' + escapeHtml(ev.team_name) + '</div>' +
          '</div>' +
        '</button>'
      );
      row.addEventListener('click', () => { modalOf(dayEventsModalEl).hide(); openEventModal(ev); });
      list.appendChild(row);
    });
    modalOf(dayEventsModalEl).show();
  }

  // ---------------- presence dropdown / theme ----------------
  document.querySelectorAll('.presence-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.preventDefault();
      const status = opt.dataset.status;
      socket.emit('presence:set', { status });
      const dot = document.getElementById('myPresenceDot');
      dot.className = 'presence-dot presence-' + (status==='reset'?'online':status);
    });
  });
  document.getElementById('toggleThemeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    const root = document.documentElement;
    const next = root.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-bs-theme', next);
    localStorage.setItem('novaconnect-theme', next);
  });

  // ---------------- boot ----------------
  document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  if (state.active.type === 'channel') { state.mentionMembers = []; api('/api/channels/' + state.active.channel.id).then(({ members }) => { state.mentionMembers = members; state.active.members = members; renderMainHeader(); }); }
  if (state.active.type === 'dm') { state.mentionMembers = state.active.participants || []; const saved = findConversation(state.active.conversation.id); if (saved) Object.assign(state.active.conversation, saved); }
  if (state.active.type === 'channel' && state.active.team) state.openTeams.add(state.active.team.id);
  renderSidebar();
  renderMainHeader();
  renderMessages(state.active.messages || []);
  document.getElementById('composer').classList.toggle('d-none', state.active.type === 'none');
})();
