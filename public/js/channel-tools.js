window.createChannelTools = function({api,escapeHtml,notify,navigate,events,presence=()=>null}) {
  const esc=escapeHtml;
  const peopleSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M2 20v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6M20 14v6m-3-3h6"/></svg>';
  function dialog(title,html) {
    const d=document.createElement('dialog'); d.className='channel-dialog';
    d.innerHTML='<header><h2>'+esc(title)+'</h2><button type="button" aria-label="Close">×</button></header><div class="channel-dialog-body">'+html+'</div>';
    document.body.append(d);d.querySelector('header button').onclick=()=>d.close();d.addEventListener('close',()=>d.remove());d.showModal();return d;
  }
  async function members(kind,id) {
    try {
      const data=await api('/api/'+kind+'/'+id+'/membership');
      const d=dialog('Members · '+data.name,'<p class="membership-note"></p><form class="membership-add"><label>Find a person<input type="search" placeholder="Name, username or email" autocomplete="off"></label><div class="people-results"></div></form><div class="membership-list"></div>');
      d.classList.add('membership-dialog');
      d.querySelector('.membership-note').textContent=data.inherited?'All team members have access. Adding someone here also adds them to the team.':'Choose Member or Owner to assign access.';
      d.querySelector('form').hidden=!data.canManage;
      d.querySelector('form').onsubmit=e=>e.preventDefault();
      const feedback=document.createElement('p');feedback.className='membership-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');d.querySelector('.membership-list').before(feedback);
      async function save(user,role) {await api('/api/'+kind+'/'+id+'/membership',{method:'POST',body:{user_id:user.id,role}});}

      function row(user,adding) {
        const r=document.createElement('div');r.className='membership-row';r.innerHTML='<span><strong>'+esc(user.full_name)+'</strong><small>@'+esc(user.username)+'</small></span>';
        const status=presence(user.id)||user.status||'offline';
        const labels={ online: 'Available', away: 'Appear away', brb: 'Be right back', busy: 'Busy', dnd: 'Do not disturb', offline: 'Appear offline' };
        const safeStatus=labels[status]?status:'offline';
        const dot=document.createElement('span');dot.className='member-presence presence-'+safeStatus+' presence-live-'+user.id;dot.setAttribute('role','img');dot.setAttribute('aria-label',labels[safeStatus]);dot.title=labels[safeStatus];r.querySelector('span').prepend(dot);
        if(data.canManage) {
          const select=document.createElement('select');select.setAttribute('aria-label','Role for '+user.full_name);select.innerHTML='<option value="member">Member</option><option value="owner">Owner</option>';select.value=user.role==='owner'?'owner':'member';r.append(select);
          const b=document.createElement('button');b.type='button';b.textContent=adding?'Add':'Save';b.onclick=async()=>{
            const role=select.value;
            if(!window.confirm((adding?'Add ':'Change ')+user.full_name+' to '+role+' in '+data.name+'?')) return;
            b.disabled=true;select.disabled=true;feedback.textContent='Saving…';
            try {
              await save(user,role);user.role=role;
              feedback.textContent=user.full_name+' '+(adding?'added':'updated')+' as '+role+'.';
              if(adding){data.members.push(user);d.querySelector('.membership-list').append(r);adding=false;}
              b.textContent='Save';
              const current=await api('/api/'+kind+'/'+id+'/membership').catch(()=>null);
              if(current&&!current.canManage){d.querySelector('form').hidden=true;d.querySelectorAll('.membership-row select,.membership-row button').forEach(e=>e.disabled=true);return;}
            }catch(e){feedback.textContent='Could not save: '+e.message;notify(e)}
            finally{if(!d.querySelector('form').hidden){b.disabled=false;select.disabled=false;}}
          };r.append(b);
        } else {const role=document.createElement('span');role.textContent=user.role;r.append(role);}
        return r;
      }
      data.members.forEach(u=>d.querySelector('.membership-list').append(row(u,false)));
      let generation=0,timer;
      d.querySelector('input').oninput=e=>{clearTimeout(timer);const q=e.target.value.trim(),g=++generation;const box=d.querySelector('.people-results');box.replaceChildren();if(!q)return;timer=setTimeout(async()=>{try{const users=await api('/api/users/search?q='+encodeURIComponent(q));if(g!==generation||!d.isConnected)return;const matches=users.filter(u=>!data.members.some(m=>m.id===u.id));box.textContent=matches.length?'':'No matching people to add.';matches.forEach(u=>box.append(row(u,true)));}catch(e){notify(e)}},200)};
    } catch(e){notify(e)}
  }
  async function pinned(channel) {
    try {
      const d=dialog('Pinned messages','<p class="pinned-empty" hidden>No pinned messages yet.</p><div class="pinned-list"></div>');
      const list=d.querySelector('.pinned-list'), empty=d.querySelector('.pinned-empty');
      const pins=await api('/api/pins?channel_id='+channel.id);
      empty.hidden=!!pins.length;
      pins.forEach(m=>{
        const row=document.createElement('div');row.className='pinned-row';
        row.innerHTML='<strong></strong><p></p><button type="button">Unpin</button>';
        row.querySelector('strong').textContent=m.author.full_name+' · '+new Date(m.created_at.replace(' ','T')+'Z').toLocaleString();
        row.querySelector('p').textContent=m.body;
        row.querySelector('button').onclick=async()=>{await api('/api/messages/'+m.id+'/pin',{method:'POST'});row.remove();if(!list.children.length)empty.hidden=false;};
        list.append(row);
      });
    } catch(e){notify(e)}
  }
  function header(container,channel,onTab) {
    container.innerHTML='<div class="channel-heading"><svg class="channel-tag" viewBox="0 0 32 32" aria-hidden="true"><path fill="#ffbf45" d="M2 17 17 2l12 1 1 12-15 15z"/><circle cx="23" cy="9" r="3" fill="white"/></svg><strong>'+esc(channel.name)+'</strong></div><nav class="channel-tabs" aria-label="Channel tabs">'+['Posts','Files','Photos'].map((t,i)=>'<button type="button" class="'+(!i?'selected':'')+'" aria-pressed="'+(!i)+'">'+t+'</button>').join('')+'</nav><div class="channel-header-actions"><button type="button" data-action="events"><i class="bi bi-calendar3"></i> Events</button><button type="button" data-action="pins" title="Pinned messages" aria-label="Pinned messages"><i class="bi bi-pin-angle"></i></button><button type="button" data-action="members" title="Add members or owners" aria-label="Add members or owners">'+peopleSvg+'</button><button type="button" data-action="link" title="Copy channel link" aria-label="Copy channel link"><i class="bi bi-link-45deg"></i></button><button type="button" data-action="settings" title="Channel settings" aria-label="Channel settings"><i class="bi bi-gear"></i></button></div>';
    container.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{container.querySelectorAll('nav button').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b))});onTab(b.textContent.toLowerCase())});
    container.querySelector('[data-action=members]').onclick=()=>members('channels',channel.id);
    container.querySelector('[data-action=events]').onclick=()=>events(channel.team_id);
    container.querySelector('[data-action=pins]').onclick=()=>pinned(channel);
    container.querySelector('[data-action=link]').onclick=async()=>{const url=location.origin+'/app/channel/'+channel.id;try{await navigator.clipboard.writeText(url);const b=container.querySelector('[data-action=link]');b.title='Link copied';b.setAttribute('aria-label','Link copied');}catch{const d=dialog('Channel link','<input readonly aria-label="Channel link">');d.querySelector('input').value=url;d.querySelector('input').select()}};
    container.querySelector('[data-action=settings]').onclick=async()=>{try{const data=await api('/api/channels/'+channel.id+'/membership');const d=dialog('Channel settings','<form><label>Name<input name="name" required maxlength="80"></label><label>Description<textarea name="description" maxlength="1000"></textarea></label><p class="settings-info"></p><button type="submit">Save</button></form>');d.querySelector('[name=name]').value=channel.name;d.querySelector('textarea').value=channel.description||'';d.querySelector('.settings-info').textContent=channel.is_private?'Private channel':'Standard channel · all team members have access';d.querySelectorAll('input,textarea,button[type=submit]').forEach(e=>e.disabled=!data.canManage);d.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await api('/api/channels/'+channel.id+'/settings',{method:'PATCH',body:{name:d.querySelector('input').value,description:d.querySelector('textarea').value}});d.close();navigate(channel.id)}catch(e){notify(e)}}}catch(e){notify(e)}};
  }
  return {members,header};
};
