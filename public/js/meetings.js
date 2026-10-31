(function () {
  'use strict';
  // Preserve basic formatting while never inserting untrusted markup or attributes.
  function safeDetails(html) {
    const template = document.createElement('template'); template.innerHTML = html;
    const allowed = new Set(['P','DIV','BR','B','STRONG','I','EM','U','S','STRIKE','UL','OL','LI','BLOCKQUOTE','A','H2','H3','SPAN','FONT','TABLE','TBODY','TR','TD','TH']);
    function clean(node) {
      if (node.nodeType === 3) return document.createTextNode(node.textContent);
      const fragment = document.createDocumentFragment();
      if (node.nodeType !== 1) return fragment;
      if (['SCRIPT','STYLE','IFRAME','OBJECT','SVG','MATH'].includes(node.tagName)) return fragment;
      const target = allowed.has(node.tagName) ? document.createElement(node.tagName.toLowerCase()) : fragment;
      for (const child of node.childNodes) target.appendChild(clean(child));
      if (target.nodeType === 1) {
        if (node.tagName === 'A' && /^(https?:\/\/|mailto:)/i.test(node.getAttribute('href') || '')) { target.href = node.getAttribute('href'); target.target = '_blank'; target.rel = 'noopener noreferrer'; }
        if (['left','right','center','justify'].includes(node.style.textAlign)) target.style.textAlign = node.style.textAlign;
        for (const prop of ['color','backgroundColor']) if (/^(#[a-f0-9]{3,8}|rgba?\([\d.,%\s]+\)|[a-z]{1,20})$/i.test(node.style[prop])) target.style[prop] = node.style[prop];
        if (node.tagName === 'FONT' && /^[1-7]$/.test(node.getAttribute('size') || '')) target.setAttribute('size',node.getAttribute('size'));
        if (node.tagName === 'FONT' && /^#[a-f0-9]{6}$/i.test(node.getAttribute('color') || '')) target.setAttribute('color',node.getAttribute('color'));
      }
      return target;
    }
    const output = document.createElement('div'); for (const child of template.content.childNodes) output.appendChild(clean(child)); return output.innerHTML;
  }
  // owners(): the people who made you their calendar delegate (src/delegates.js) — you may send a
  // meeting as one of them, and open their meetings to answer or cancel them.
  window.createMeetings = function ({api, currentUser, onSaved, owners = () => []}) {
    let dialog;
    function close() { if (dialog) { dialog.close(); dialog.remove(); dialog = null; } }
    function shell(title) {
      close(); const d = document.createElement('dialog'); d.className='meeting-dialog'; d.setAttribute('aria-label',title);
      d.innerHTML='<header class="meeting-header"><span class="meeting-mark"><i class="bi bi-calendar-week"></i></span><h1></h1><span class="meeting-tab">Details</span><div class="meeting-header-actions"></div></header><div class="meeting-content"></div>';
      d.querySelector('h1').textContent=title; d.addEventListener('cancel',e=>{e.preventDefault();close();}); document.body.appendChild(d); dialog=d; d.showModal(); return d;
    }
    function button(text,primary,fn) { const b=document.createElement('button');b.type='button';b.className='chat-action'+(primary?' chat-action-primary':'');b.textContent=text;b.onclick=fn;return b; }
    function open(active = {participants:[],conversation:{id:null}}, opts = {}) {
      const d=shell('New meeting'), content=d.querySelector('.meeting-content');
      content.innerHTML=`<form class="meeting-form">
        <div class="meeting-zone"><label>Time zone: <select name="timezone" aria-label="Time zone"></select></label><label class="meeting-organizer" hidden>Organizer: <select name="organizer" aria-label="Organizer"></select></label></div>
        <div class="meeting-fields">
          <p class="meeting-notice"><i class="bi bi-info-circle"></i> Invitations appear in NovaConnect Activity and the attendees’ calendars.</p>
          <label class="meeting-row"><i class="bi bi-pencil"></i><input name="title" placeholder="Add title" aria-label="Meeting title" maxlength="200" required autofocus></label>
          <div class="meeting-row"><i class="bi bi-person-plus"></i><div class="meeting-attendees"><div class="meeting-pills"></div><input name="people" placeholder="Add attendees" aria-label="Add attendees" autocomplete="off"><div class="meeting-people-results"></div></div></div>
          <div class="meeting-row"><i class="bi bi-clock"></i><div class="meeting-times"><input type="date" name="start_date" aria-label="Start date" required><input type="time" name="start_time" aria-label="Start time" required><span>→</span><input type="date" name="end_date" aria-label="End date" required><input type="time" name="end_time" aria-label="End time" required><span class="meeting-duration"></span><label class="meeting-switch"><input type="checkbox" name="all_day"> All day</label></div></div>
          <div class="meeting-row"><i class="bi bi-arrow-repeat"></i><div class="meeting-repeat"><select name="recurrence" aria-label="Repeat"><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select><label class="meeting-count" hidden>Occurrences <input type="number" name="count" value="4" min="1" max="52"></label></div></div>
          <div class="meeting-conflicts" role="status" aria-live="polite" hidden></div>
          <div class="meeting-row"><i class="bi bi-sliders"></i><details><summary class="chat-action">Advanced options</summary><label class="meeting-advanced"><input type="checkbox" name="request_rsvp" checked> Request responses</label><label class="meeting-advanced">Show as <select name="show_as"><option value="busy">Busy</option><option value="free">Free</option></select></label></details></div>
          <label class="meeting-row"><i class="bi bi-geo-alt"></i><input name="location" placeholder="Add location" aria-label="Location" maxlength="500"></label>
          <div class="meeting-row"><i class="bi bi-list-ul"></i><div class="meeting-editor"><div class="meeting-toolbar" role="toolbar" aria-label="Format meeting details"></div><div class="meeting-richtext" contenteditable="true" role="textbox" aria-label="Meeting details" aria-multiline="true" data-placeholder="Type details for this new meeting"></div></div></div>
          <p class="meeting-error" role="status"></p>
        </div>
      </form>`;
      const form=content.querySelector('form'), f=form.elements, err=content.querySelector('.meeting-error');
      // Calendar delegates: send as yourself or as someone whose calendar you manage.
      const ownerList=owners();
      if(ownerList.length){
        content.querySelector('.meeting-organizer').hidden=false;
        [{id:currentUser.id,full_name:'Me'},...ownerList].forEach(o=>{const opt=document.createElement('option');opt.value=o.id;opt.textContent=o.id===currentUser.id?'Me':o.full_name+' (as their delegate)';f.organizer.appendChild(opt);});
        if(opts.organizerId&&ownerList.some(o=>o.id===Number(opts.organizerId)))f.organizer.value=String(opts.organizerId);
      }
      const onBehalf=()=>{const v=f.organizer&&Number(f.organizer.value);return v&&v!==currentUser.id?v:undefined;};
      const selected=new Map(active.participants.filter(u=>u.id!==currentUser.id).map(u=>[u.id,u]));
      const zone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const zones=[...new Set([zone,'UTC','America/Chicago',...(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['America/New_York','America/Los_Angeles','Europe/London','Asia/Kolkata'])])];
      zones.forEach(z=>{const opt=document.createElement('option');opt.value=z;opt.textContent=z==='America/Chicago'?'Central Time (US & Canada) — America/Chicago':z.replace(/_/g,' ');f.timezone.appendChild(opt);}); f.timezone.value=zone;
      const now=new Date();now.setMinutes(Math.ceil(now.getMinutes()/15)*15,0,0);const end=new Date(+now+30*60000);
      const date=x=>x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');
      const time=x=>String(x.getHours()).padStart(2,'0')+':'+String(x.getMinutes()).padStart(2,'0');
      f.start_date.value=date(now);f.end_date.value=date(end);f.start_time.value=time(now);f.end_time.value=time(end);
      function duration() {
        f.start_time.disabled=f.end_time.disabled=f.all_day.checked;
        const minutes=(new Date(f.end_date.value+'T'+f.end_time.value)-new Date(f.start_date.value+'T'+f.start_time.value))/60000;
        content.querySelector('.meeting-duration').textContent=f.all_day.checked?'All day':Number.isFinite(minutes)&&minutes>0?minutes+'m':'';
      }
      ['start_date','end_date','start_time','end_time','all_day'].forEach(n=>f[n].addEventListener('change',duration)); duration();
      f.recurrence.onchange=()=>{content.querySelector('.meeting-count').hidden=f.recurrence.value==='none';};
      function pills() {
        const box=content.querySelector('.meeting-pills');box.replaceChildren();selected.forEach(u=>{
          const pill=button(u.full_name+' ×',false,()=>{selected.delete(u.id);pills();});pill.setAttribute('aria-label','Remove '+u.full_name);box.appendChild(pill);
        });
        onPeopleChanged();
      }
      let onPeopleChanged=()=>{};   // the conflict check, once it is set up below
      pills();
      let generation=0,timer;
      f.people.oninput=()=>{
        clearTimeout(timer);const gen=++generation,q=f.people.value.trim();const box=content.querySelector('.meeting-people-results');box.replaceChildren();if(!q)return;
        timer=setTimeout(async()=>{try{
          const users=await api('/api/users/search?q='+encodeURIComponent(q));if(dialog!==d||gen!==generation)return;
          users.filter(u=>!selected.has(u.id)).forEach(u=>{const b=button(u.full_name+(u.email?' · '+u.email:''),false,()=>{selected.set(u.id,u);pills();f.people.value='';box.replaceChildren();++generation;});box.appendChild(b);});
          if(!box.children.length)box.textContent='No matching people.';
        }catch(e){if(dialog===d&&gen===generation)err.textContent=e.message;}},200);
      };
      const editor=content.querySelector('.meeting-richtext'), toolbar=content.querySelector('.meeting-toolbar');
      let selection;
      const remember=()=>{const sel=window.getSelection();if(sel.rangeCount&&editor.contains(sel.anchorNode))selection=sel.getRangeAt(0).cloneRange();};
      editor.addEventListener('keyup',remember);editor.addEventListener('mouseup',remember);editor.addEventListener('input',remember);
      const command=(cmd,value)=>{editor.focus();if(selection){const sel=window.getSelection();sel.removeAllRanges();sel.addRange(selection);}document.execCommand(cmd,false,value);remember();};
      const controls=[['type-bold','Bold','bold'],['type-italic','Italic','italic'],['type-underline','Underline','underline'],['type-strikethrough','Strikethrough','strikeThrough'],['highlighter','Highlight','hiliteColor','#fff2a8'],['text-indent-left','Decrease indent','outdent'],['text-indent-right','Increase indent','indent'],['list-ul','Bulleted list','insertUnorderedList'],['list-ol','Numbered list','insertOrderedList'],['quote','Quote','formatBlock','blockquote'],['link-45deg','Insert link','link'],['text-center','Center align','justifyCenter'],['table','Insert table','table'],['arrow-counterclockwise','Undo','undo'],['arrow-clockwise','Redo','redo']];
      controls.forEach(([icon,title,cmd,value])=>{const b=button('',false,()=>{
        if(cmd==='link'){const url=prompt('Link URL (https://…)');if(url&&/^https?:\/\//i.test(url))command('createLink',url);return;}
        if(cmd==='table'){command('insertHTML','<table><tbody><tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr></tbody></table><p><br></p>');return;}
        command(cmd,value);
      });b.innerHTML='<i class="bi bi-'+icon+'"></i>';b.title=title;b.setAttribute('aria-label',title);b.onmousedown=e=>e.preventDefault();toolbar.appendChild(b);});
      const size=document.createElement('select');size.setAttribute('aria-label','Text size');size.innerHTML='<option value="3">Normal</option><option value="2">Small</option><option value="5">Large</option>';size.onchange=()=>command('fontSize',size.value);toolbar.appendChild(size);
      const color=document.createElement('input');color.type='color';color.value='#444444';color.title='Text color';color.setAttribute('aria-label','Text color');color.oninput=()=>command('foreColor',color.value);toolbar.appendChild(color);
      const paragraph=document.createElement('select');paragraph.setAttribute('aria-label','Paragraph style');paragraph.innerHTML='<option value="p">Paragraph</option><option value="h2">Heading</option><option value="h3">Subheading</option>';paragraph.onchange=()=>command('formatBlock',paragraph.value);toolbar.appendChild(paragraph);
      editor.addEventListener('paste',e=>{e.preventDefault();command('insertText',e.clipboardData.getData('text/plain'));});
      // The time fields as POST /api/meetings (and the conflicts check) take them.
      function timeFields() {
        let endDate=f.end_date.value;
        if(f.all_day.checked){const x=new Date(endDate+'T12:00');x.setDate(x.getDate()+1);endDate=date(x);}
        return {on_behalf_of:onBehalf(),attendee_ids:[...selected.keys()],timezone:f.timezone.value,start_local:f.start_date.value+'T'+(f.all_day.checked?'00:00':f.start_time.value),end_local:endDate+'T'+(f.all_day.checked?'00:00':f.end_time.value),all_day:f.all_day.checked,recurrence:f.recurrence.value,count:Number(f.count.value)};
      }
      // Conflict warnings (src/meetingConflicts.js): who is already busy then. Never blocks sending.
      const conflictBox=content.querySelector('.meeting-conflicts');let conflictGen=0,conflictTimer;
      function scheduleConflictCheck() {
        clearTimeout(conflictTimer);const gen=++conflictGen;
        conflictTimer=setTimeout(async()=>{
          let data;try{data=await api('/api/meetings/conflicts',{method:'POST',body:timeFields()});}catch(_){data=null;}
          if(dialog!==d||gen!==conflictGen)return;
          if(!data||!data.conflicts.length){conflictBox.hidden=true;conflictBox.replaceChildren();return;}
          const zoneName=f.timezone.value;
          // In the form's own time zone: 'Fri, Oct 30' / 'Fri, Oct 30, 10:00 AM' / '10:30 AM'.
          const fmt=(t,mode)=>{const x=new Date(t.replace(' ','T')+'Z');const o=mode==='time'?{hour:'numeric',minute:'2-digit'}:mode==='date'?{weekday:'short',month:'short',day:'numeric'}:{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'};try{return x.toLocaleString([],{timeZone:zoneName,...o});}catch(_){return x.toLocaleString();}};
          const head=document.createElement('strong');head.innerHTML='<i class="bi bi-exclamation-triangle"></i> ';
          head.append(document.createTextNode(data.conflicts.length===1&&data.conflicts[0].is_me?'You already have something at this time':'Some people are already busy at this time'));
          const list=document.createElement('ul');
          for(const p of data.conflicts){
            const li=document.createElement('li');
            const shown=p.items.slice(0,3).map(i=>(i.title?'“'+i.title+'” ':'busy ')+(i.all_day?fmt(i.start_at,'date')+' (all day)':fmt(i.start_at)+'–'+fmt(i.end_at,'time')));
            li.textContent=(p.is_me?'You':p.full_name)+': '+shown.join('; ')+(p.items.length>3?' and '+(p.items.length-3)+' more':'')+(data.occurrences>1?' ('+p.occurrences_affected+' of '+data.occurrences+' occurrences)':'');
            list.appendChild(li);
          }
          const note=document.createElement('small');note.textContent='You can still send the invitation.';
          conflictBox.replaceChildren(head,list,note);conflictBox.hidden=false;
        },400);
      }
      ['start_date','end_date','start_time','end_time','all_day','timezone','recurrence','count','organizer'].forEach(n=>f[n]&&f[n].addEventListener('change',scheduleConflictCheck));
      onPeopleChanged=scheduleConflictCheck;
      scheduleConflictCheck();
      const send=button('Send',true,()=>form.requestSubmit());d.querySelector('.meeting-header-actions').append(send,button('Close',false,close));
      form.onsubmit=async e=>{
        e.preventDefault();if(send.disabled)return;
        if(!selected.size){err.textContent='Add at least one attendee.';return;}
        const body={conversation_id:active.conversation.id,title:f.title.value.trim(),...timeFields(),request_rsvp:f.request_rsvp.checked,show_as:f.show_as.value,location:f.location.value,details:safeDetails(editor.innerHTML)};
        send.disabled=true;err.textContent='Sending invitations…';
        try {await api('/api/meetings',{method:'POST',body});if(dialog===d)close();onSaved();}catch(e){if(dialog===d){err.textContent=e.message;send.disabled=false;}}
      };
      f.title.focus();
    }
    // opts.forUser: open it as someone whose calendar you manage (answer or cancel it for them).
    async function show(id, opts = {}) {
      const forUser=opts.forUser&&Number(opts.forUser)!==currentUser.id?Number(opts.forUser):null;
      const forQuery=forUser?'?for='+forUser:'';
      const d=shell('Meeting details');const content=d.querySelector('.meeting-content');content.textContent='Loading…';d.querySelector('.meeting-header-actions').append(button('Close',false,close));
      try {
        const {meeting:m,attendees,conflicts}=await api('/api/meetings/'+id+forQuery);if(dialog!==d)return;
        content.replaceChildren();const body=document.createElement('div');body.className='meeting-fields';
        const h=document.createElement('h2');h.textContent=m.title;body.appendChild(h);
        if(m.meet_code&&/^[a-f0-9]{24}$/.test(m.meet_code)){const join=document.createElement('a');join.className='chat-action chat-action-primary';join.textContent='Join meeting';join.href='/app/meet/'+m.meet_code;body.append(join);}
        if(forUser){const who=(owners().find(o=>o.id===forUser)||{}).full_name||'them';const note=document.createElement('p');note.className='meeting-notice';note.textContent='You are viewing this as '+who+'’s calendar delegate: answers and cancelling are for them.';body.appendChild(note);}
        for(const text of [m.local_start.replace('T',' ')+' → '+m.local_end.replace('T',' ')+' ('+m.timezone+')', 'Organizer: '+m.organizer+(m.scheduled_by_name?' (sent by '+m.scheduled_by_name+')':''), 'Location: '+(m.location||'Not specified'), 'Show as: '+(m.show_as||'busy'), 'Attendees: '+attendees.map(a=>a.full_name+' — '+a.response).join(', ')]) {const p=document.createElement('p');p.textContent=text;body.appendChild(p);}
        const details=document.createElement('div');details.className='meeting-richtext';details.innerHTML=safeDetails(m.details);body.appendChild(details);
        if(conflicts&&conflicts.length){
          const warn=document.createElement('div');warn.className='meeting-conflicts';
          const z=m.timezone;const fmt=t=>{const x=new Date(t.replace(' ','T')+'Z');try{return x.toLocaleString([],{timeZone:z,weekday:'short',hour:'numeric',minute:'2-digit'});}catch(_){return x.toLocaleString();}};
          warn.textContent='⚠ At the same time you have: '+conflicts.map(c=>(c.title?'“'+c.title+'”':'another meeting')+' ('+(c.all_day?'all day':fmt(c.start_at)+'–'+fmt(c.end_at))+')').join('; ');
          body.appendChild(warn);
        }
        const feedback=document.createElement('p');feedback.setAttribute('role','status');body.appendChild(feedback);
        const actingId=forUser||currentUser.id;
        if(m.created_by===actingId)body.appendChild(button('Cancel this meeting',false,async()=>{if(!confirm('Cancel this meeting for all attendees?'))return;try{await api('/api/meetings/'+id+forQuery,{method:'DELETE'});close();onSaved();}catch(e){feedback.textContent=e.message;}}));
        else if(m.request_rsvp) for(const response of ['accepted','tentative','declined'])body.appendChild(button(response[0].toUpperCase()+response.slice(1),false,async()=>{try{await api('/api/meetings/'+id+'/response',{method:'POST',body:{response,on_behalf_of:forUser||undefined}});feedback.textContent='Response saved: '+response;onSaved();}catch(e){feedback.textContent=e.message;}}));
        content.appendChild(body);
      }catch(e){if(dialog===d)content.textContent=e.message;}
    }
    return {open,show};
  };
})();
