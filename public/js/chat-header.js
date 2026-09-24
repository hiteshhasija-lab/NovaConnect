(function () {
  'use strict';
  const icons = {
    more: '<circle cx="4" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="20" cy="12" r="1.6"/>',
    video: '<rect x="2" y="6" width="14" height="13" rx="4"/><path d="M18 10l4-3v11l-4-3z"/>',
    audio: '<path d="M7 2C3 2 2 5 3 9c2 6 6 10 12 13 3 1 6-1 6-4l-1-3c-.4-1-1-1-2-.7l-3 1.6c-2-1-4-3-5-5l1.5-2.5c.5-.7.5-1.5 0-2.2L9 3C8.5 2.3 8 2 7 2z"/>',
    people: '<circle cx="8" cy="6" r="3"/><circle cx="17" cy="7" r="2.7"/><path d="M2 17v-2c0-3 2-5 6-5 2 0 4 1 5 3a7 7 0 0 0-2 7H7c-3 0-5-1-5-3zM16 11c4 0 6 2 6 4a7 7 0 0 0-8-2z"/><circle cx="18" cy="19" r="5"/><path d="M18 16v6m-3-3h6" stroke="var(--surface,white)" stroke-width="1.7"/>',
    search: '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m15 15 7 7" fill="none" stroke="currentColor" stroke-width="1.6"/>'
  };
  window.createChatHeader = function ({ api, currentUser, calls, navigate, preferences, removed, meetings, notify }) {
    let open = null;
    function close(restore = true) {
      if (!open) return;
      const old = open; open = null;
      clearTimeout(old.timer); old.panel.remove();
      old.button.setAttribute('aria-expanded', 'false');
      if (restore && old.button.isConnected) old.button.focus();
    }
    document.addEventListener('pointerdown', e => { if (open && !open.panel.contains(e.target) && !open.button.contains(e.target)) close(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { e.preventDefault(); close(); } });
    function button(kind, label) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chat-tool chat-tool-' + kind;
      b.title = label; b.setAttribute('aria-label', label);
      b.innerHTML = '<svg viewBox="0 0 24 26" aria-hidden="true" fill="currentColor">' + icons[kind] + '</svg>';
      return b;
    }
    function popup(b, title, inputPlaceholder) {
      if (open?.button === b) { close(); return null; }
      close(false);
      const panel = document.createElement('section'); panel.className = 'chat-popover'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', title);
      panel.innerHTML = '<h2></h2><div class="chat-pills"></div><input class="chat-entry" autocomplete="off"><p class="chat-feedback" role="status"></p><div class="chat-results"></div><div class="chat-popover-actions"></div>';
      panel.querySelector('h2').textContent = title;
      const input = panel.querySelector('input'); input.placeholder = inputPlaceholder; input.setAttribute('aria-label', inputPlaceholder);
      const host=b.closest('.chat-tools');
      if(host)host.appendChild(panel);else{document.body.appendChild(panel);panel.classList.add('chat-row-popup');}
      b.setAttribute('aria-expanded', 'true');
      open = { panel, button: b, input, generation: 0 };
      input.focus(); return open;
    }
    function action(text, primary, handler) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chat-action' + (primary ? ' chat-action-primary' : ''); b.textContent = text; b.onclick = handler; return b;
    }
    function group(b, active) {
      const p = popup(b, 'Add people', 'Enter name, email or username'); if (!p) return;
      const existing = active.participants.filter(u => u.id !== currentUser.id);
      const selected = new Map();
      const results = p.panel.querySelector('.chat-results'), pills = p.panel.querySelector('.chat-pills'), feedback = p.panel.querySelector('.chat-feedback');
      let saving = false;
      const create = action('Add', true, async () => {
        if (saving || !selected.size) return;
        saving = true; create.disabled = true; feedback.textContent = 'Adding to this chat…';
        try {
          await api('/api/dm/' + active.conversation.id + '/participants', { method: 'POST', body: { user_ids: [...selected.keys()] } });
          if (open === p) close(false);
          navigate(active.conversation.id);
        } catch (e) { if (open === p) { feedback.textContent = e.message; saving = false; create.disabled = !selected.size; } }
      });
      create.disabled = true;
      const actions = p.panel.querySelector('.chat-popover-actions');
      actions.append(action('Cancel', false, () => close()), create);
      function renderSelected() {
        pills.replaceChildren();
        selected.forEach(u => {
          const pill = action(u.full_name + ' ×', false, () => { if (saving) return; selected.delete(u.id); renderSelected(); });
          pill.setAttribute('aria-label', 'Remove ' + u.full_name); pills.appendChild(pill);
        });
        create.disabled = saving || !selected.size;
      }
      p.input.oninput = () => {
        clearTimeout(p.timer); const generation = ++p.generation; const q = p.input.value.trim(); results.replaceChildren(); feedback.textContent = '';
        if (!q) return;
        p.timer = setTimeout(async () => {
          feedback.textContent = 'Searching…';
          try {
            const users = await api('/api/users/search?q=' + encodeURIComponent(q));
            if (open !== p || p.generation !== generation) return;
            const available = users.filter(u => !selected.has(u.id) && !existing.some(e => e.id === u.id));
            feedback.textContent = available.length ? '' : 'No matching people to add.';
            available.forEach(u => {
              const row = action(u.full_name + (u.email ? ' · ' + u.email : ' · @' + u.username), false, () => {
                if (saving) return;
                selected.set(u.id, u); renderSelected(); results.replaceChildren(); p.input.value = ''; feedback.textContent = ''; ++p.generation; p.input.focus();
              }); row.classList.add('chat-person'); results.appendChild(row);
            });
          } catch (e) { if (open === p && p.generation === generation) feedback.textContent = e.message; }
        }, 200);
      };
    }
    function search(b, active) {
      const p = popup(b, 'Search this chat', 'Search messages'); if (!p) return;
      const results = p.panel.querySelector('.chat-results'), feedback = p.panel.querySelector('.chat-feedback');
      const actions = p.panel.querySelector('.chat-popover-actions');
      const more = action('Load more', false, () => load(true)); more.hidden = true;
      actions.append(action('Close', false, () => close()), more);
      let cursor = null, query = '', count = 0;
      async function load(append) {
        const generation = ++p.generation;
        if (!append) { results.replaceChildren(); cursor = null; count = 0; query = p.input.value.trim(); }
        more.hidden = true; feedback.textContent = '';
        if (!query) return;
        feedback.textContent = 'Searching…';
        try {
          const data = await api('/api/dm/' + active.conversation.id + '/search?q=' + encodeURIComponent(query) + (append && cursor ? '&before=' + cursor : ''));
          if (open !== p || generation !== p.generation) return;
          data.messages.forEach(m => {
            const row = document.createElement('article'); row.className = 'chat-search-result';
            const meta = document.createElement('strong'); meta.textContent = (m.author_name || 'Former member') + (m.parent_message_id ? ' · Thread reply' : '') + ' · ' + new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleString();
            const body = document.createElement('p'); body.textContent = m.body;
            row.append(meta, body); results.appendChild(row);
          });
          count += data.messages.length; cursor = data.next_before;
          feedback.textContent = count ? count + ' matching message' + (count === 1 ? '' : 's') + (cursor ? ' shown' : '') : 'No matching messages.';
          more.hidden = !cursor;
        } catch (e) { if (open === p && generation === p.generation) { feedback.textContent = e.message; more.hidden = !cursor; } }
      }
      p.input.maxLength = 200;
      p.input.oninput = () => { clearTimeout(p.timer); ++p.generation; more.hidden = true; p.timer = setTimeout(() => load(false), 250); };
      p.input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(p.timer); load(false); } };
    }
    function pinnedMessages(b, active) {
      const p = popup(b, 'Pinned messages', ''); if (!p) return;
      p.input.remove();
      const results = p.panel.querySelector('.chat-results'), feedback = p.panel.querySelector('.chat-feedback');
      p.panel.querySelector('.chat-popover-actions').append(action('Close', false, () => close()));
      feedback.textContent = 'Loading…';
      api('/api/pins?conversation_id=' + active.conversation.id).then(pins => {
        if (open !== p) return;
        feedback.textContent = pins.length ? '' : 'No pinned messages yet.';
        pins.forEach(m => {
          const row = document.createElement('article'); row.className = 'chat-search-result';
          const meta = document.createElement('strong'); meta.textContent = m.author.full_name + ' · ' + new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleString();
          const body = document.createElement('p'); body.textContent = m.body;
          const unpin = action('Unpin', false, async () => { await api('/api/messages/' + m.id + '/pin', { method: 'POST' }); row.remove(); if (!results.children.length) feedback.textContent = 'No pinned messages yet.'; });
          row.append(meta, body, unpin); results.appendChild(row);
        });
      }).catch(e => { if (open === p) feedback.textContent = e.message; });
    }
    function menu(b, active) {
      const p = popup(b, 'More chat options', ''); if (!p) return;
      p.panel.classList.add('chat-menu'); p.panel.setAttribute('role','menu');
      p.panel.replaceChildren();
      const c = active.conversation;
      const add = (icon, text, handler, shortcut) => {
        const item = document.createElement('button'); item.type = 'button'; item.className = 'chat-menu-item'; item.setAttribute('role','menuitem');
        item.innerHTML = '<i aria-hidden="true" class="bi bi-' + icon + '"></i><span></span>' + (shortcut ? '<small>' + shortcut + '</small>' : '');
        item.querySelector('span').textContent = text;
        item.onclick = () => { close(false); Promise.resolve(handler()).catch(notify); };
        p.panel.appendChild(item);
      };
      const line = () => p.panel.appendChild(document.createElement('hr'));
      add('box-arrow-up-right', 'Open in new window', () => window.open('/app/dm/' + c.id, '_blank', 'noopener,noreferrer,width=1150,height=850'), '⌘ O');
      line();
      add('calendar-plus', 'Schedule meeting', () => meetings.open(active));
      add('arrow-up-square', 'Screen sharing', () => {
        if (c.is_group || active.participants.length !== 2) return notify(new Error('Screen sharing is available in one-to-one chats.'));
        return calls.share(c.id, active.participants.find(u => u.id !== currentUser.id).full_name);
      }, '⇧ ⌘ E');
      line();
      add('pin-angle', 'Pinned messages', () => pinnedMessages(active));
      add('envelope', 'Mark as unread', () => preferences(c.id, { is_unread: true }));
      add(c.is_favorite ? 'heart-fill' : 'heart', c.is_favorite ? 'Remove from favorites' : 'Favorite', () => preferences(c.id, { is_favorite: !c.is_favorite }));
      add(c.is_muted ? 'bell' : 'bell-slash', c.is_muted ? 'Unmute' : 'Mute', () => preferences(c.id, { is_muted: !c.is_muted }));
      line();
      add('exclamation-triangle', 'Report a concern', () => report(b, active));
      if (!c.is_group && active.participants.length === 2) {
        const other = active.participants.find(u => u.id !== currentUser.id);
        add('slash-circle', 'Block ' + other.full_name, async () => {
          if (!confirm('Block ' + other.full_name + '? You will no longer be able to message each other or find each other in search. This does not delete your existing messages.')) return;
          await api('/api/users/' + other.id + '/block', { method: 'POST' });
          await preferences(c.id, { is_hidden: true });
          removed(c.id);
        });
      }
      add('trash', 'Delete', async () => {
        if (!confirm('Delete this chat from your list? Other people keep their messages. A new message will bring the chat back.')) return;
        await preferences(c.id, { is_hidden: true });
        removed(c.id);
      });
      if(p.panel.classList.contains('chat-row-popup')){const rect=b.getBoundingClientRect();p.panel.style.left=Math.max(8,Math.min(rect.left,innerWidth-270))/.77+'px';p.panel.style.top=Math.max(8,Math.min(rect.bottom,innerHeight-p.panel.getBoundingClientRect().height-8))/.77+'px';}
      p.panel.onkeydown = e => {
        const items = [...p.panel.querySelectorAll('button')]; const index = items.indexOf(document.activeElement);
        if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
          e.preventDefault();
          const target = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[target].focus();
        }
      };
      p.panel.querySelector('button').focus();
    }
    function report(b, active) {
      const categories = ['Sexually inappropriate','Terrorist or violent extremist content','Child sexual exploitation or abuse','Harassment or threats','Harm to persons or property (suicide, self-harm, eating disorders)','Malware or viruses','Fraud or spam','Hate Speech','Copyright and trademark infringement','Harmful substances','Non-consensual intimate imagery','Other'];
      const d=document.createElement('dialog'); d.className='concern-dialog'; d.setAttribute('aria-labelledby','concernTitle');
      d.innerHTML='<header><h2 id="concernTitle">Report a concern</h2><button type="button" class="concern-close" aria-label="Close">×</button></header><form><div class="concern-body"><p>Tell us your concern. <button type="button" class="concern-link" id="concernLearn">Learn more</button></p><p class="concern-help" hidden>Reports are saved for NovaConnect administrators to review. Select the category that best describes your concern and provide useful context.</p><fieldset><legend class="visually-hidden">Concern category</legend></fieldset><textarea name="details" maxlength="2000" placeholder="Include details about the offensive behavior" aria-label="Include details about the offensive behavior"></textarea><p class="concern-privacy">Please do not provide any personal or sensitive information. <button type="button" class="concern-link" id="concernPrivacy">Privacy and choices</button></p><p class="concern-privacy-help" hidden>Your selected category, details, account identifier, chat identifier and submission time are saved for administrators. No report is emailed externally.</p><p class="concern-status" role="status"></p></div><footer><button type="button" class="chat-action" id="concernCancel">Cancel</button><button type="submit" class="chat-action chat-action-primary" id="concernSend" disabled>Send</button></footer></form>';
      const form=d.querySelector('form'),fieldset=d.querySelector('fieldset'),send=d.querySelector('#concernSend');
      categories.forEach((category,i)=>{
        const label=document.createElement('label'); label.className='concern-choice';
        const radio=document.createElement('input');radio.type='radio';radio.name='category';radio.value=category;radio.required=true;
        const text=document.createElement('span');text.textContent=category;label.append(radio,text);fieldset.appendChild(label);
        if(i===8){const help=document.createElement('small');help.textContent='For copyright issues, include the work and the message or content you are reporting.';text.appendChild(help);}
        radio.onchange=()=>{send.disabled=false;};
      });
      const dismiss=()=>{d.close();d.remove();if(b.isConnected)b.focus();};
      d.querySelector('.concern-close').onclick=d.querySelector('#concernCancel').onclick=dismiss;
      d.oncancel=e=>{e.preventDefault();dismiss();};
      d.querySelector('#concernLearn').onclick=()=>{d.querySelector('.concern-help').hidden=!d.querySelector('.concern-help').hidden;};
      d.querySelector('#concernPrivacy').onclick=()=>{d.querySelector('.concern-privacy-help').hidden=!d.querySelector('.concern-privacy-help').hidden;};
      form.onsubmit=async e=>{
        e.preventDefault();if(send.disabled)return;send.disabled=true;
        const status=d.querySelector('.concern-status');status.textContent='Sending report…';
        try {await api('/api/dm/'+active.conversation.id+'/report',{method:'POST',body:{category:form.elements.category.value,reason:form.elements.details.value.trim()}});status.textContent='Your concern has been sent to NovaConnect administrators.';send.hidden=true;fieldset.disabled=true;form.elements.details.disabled=true;}
        catch(e){status.textContent=e.message;send.disabled=false;}
      };
      document.body.appendChild(d);d.showModal();
    }
    return { menu, close, render(header, active) {
      const tools = document.createElement('div'); tools.className = 'chat-tools'; tools.setAttribute('aria-label', 'Chat actions');
      const others = active.participants.filter(u => u.id !== currentUser.id);
      if (!active.conversation.is_group && others.length === 1) {
        for (const mode of ['video', 'audio']) {
          const b = button(mode, mode === 'video' ? 'Video call' : 'Audio call');
          b.onclick = () => { close(); calls.start(active.conversation.id, mode, others[0].full_name); }; tools.appendChild(b);
        }
      }
      const people = button('people', 'Add people'); people.setAttribute('aria-haspopup', 'dialog'); people.setAttribute('aria-expanded', 'false'); people.onclick = () => group(people, active); tools.appendChild(people);
      const divider = document.createElement('span'); divider.className = 'chat-tool-divider'; divider.setAttribute('aria-hidden','true'); tools.appendChild(divider);
      const find = button('search', 'Search this chat'); find.setAttribute('aria-haspopup','dialog'); find.setAttribute('aria-expanded','false'); find.onclick = () => search(find, active); tools.appendChild(find);
      const more = button('more', 'More chat options'); more.setAttribute('aria-haspopup','menu'); more.setAttribute('aria-expanded','false'); more.onclick = () => menu(more, active); tools.appendChild(more);
      header.appendChild(tools);
    } };
  };
})();
