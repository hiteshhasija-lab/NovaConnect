window.createChatList=function({escapeHtml:esc,avatarHtml,currentUser,onOpen,onNew,onMeet,onMenu,presence}){
 let query='',searchOpen=false,collapsed=false;const filters=new Set();
 function render({title,actions,body,conversations,activeId,unread}){
  const focused=document.activeElement?.id==='chatListSearch',cursor=focused?document.activeElement.selectionStart:null;
  title.textContent='Chat';actions.replaceChildren();body.replaceChildren();
  function action(name,icon,fn){const b=document.createElement('button');b.type='button';b.title=name;b.setAttribute('aria-label',name);b.innerHTML='<i aria-hidden="true" class="bi bi-'+icon+'"></i>';b.onclick=fn;actions.append(b);return b}
  const searchButton=action('Search chats','search',()=>{searchOpen=!searchOpen;search.hidden=!searchOpen;searchButton.setAttribute('aria-expanded',String(searchOpen));if(searchOpen)search.focus();else{query='';search.value='';draw()}});
  action('Meet','camera-video',onMeet);action('New chat','pencil-square',onNew);
  const search=document.createElement('input');search.id='chatListSearch';search.type='search';search.className='chat-list-search';search.placeholder='Search chats';search.setAttribute('aria-label','Search chats');search.hidden=!searchOpen;search.value=query;search.oninput=()=>{query=search.value;draw()};searchButton.setAttribute('aria-expanded',String(searchOpen));body.append(search);
  const bar=document.createElement('div');bar.className='chat-list-filters';
  for(const [key,label] of [['unread','Unread'],['meeting','Meeting chats'],['unmuted','Unmuted']]){const b=document.createElement('button');b.type='button';b.textContent=label;b.setAttribute('aria-pressed',String(filters.has(key)));b.onclick=()=>{filters.has(key)?filters.delete(key):filters.add(key);b.setAttribute('aria-pressed',String(filters.has(key)));draw()};bar.append(b)}body.append(bar);
  const heading=document.createElement('button');heading.type='button';heading.className='chat-list-heading';heading.onclick=()=>{collapsed=!collapsed;draw()};body.append(heading);
  const list=document.createElement('div');list.className='chat-list-rows';body.append(list);
  function draw(){heading.textContent=(collapsed?'›':'⌄')+' Chats';heading.setAttribute('aria-expanded',String(!collapsed));list.hidden=collapsed;list.replaceChildren();
   const rows=conversations.filter(c=>!c.is_hidden&&(!filters.has('unread')||(unread.has(c.id)||c.is_unread))&&(!filters.has('unmuted')||!c.is_muted)&&(!filters.has('meeting')||c.is_meeting_chat)&&(!query||[c.name,...(c.participants||[]).map(u=>u.full_name+' '+u.username),c.last_message?.body].join(' ').toLowerCase().includes(query.toLowerCase()))).sort((a,b)=>(b.is_favorite||0)-(a.is_favorite||0)||String(b.last_message?.created_at||b.created_at||'').localeCompare(String(a.last_message?.created_at||a.created_at||'')));
   if(!rows.length){list.textContent=query||filters.size?'No chats match these filters.':'No chats yet. Start a new chat.';return}
   for(const c of rows){const other=c.participants?.[0],name=c.name||(c.participants||[]).map(u=>u.full_name).join(', ')||'Conversation',status=other?(presence(other.id)||other.status||'offline'):'offline',m=c.last_message;
    const preview=m?(m.deleted?'This message was deleted':(m.user_id===currentUser.id?'You: ':m.author_name?m.author_name+': ':'')+(m.body||'Attachment')):'No messages yet';
    const when=m?.created_at||c.created_at;const date=when?new Date(when.replace(' ','T')+'Z'):null;const stamp=date&&!isNaN(date)?date.toLocaleDateString(undefined,{month:'numeric',day:'numeric',...(date.getFullYear()!==new Date().getFullYear()?{year:'2-digit'}:{})}):'';
    const row=document.createElement('div');row.className='chat-list-row'+(c.id===activeId?' active':'');row.dataset.convoId=c.id;
    const open=document.createElement('button');open.type='button';open.className='chat-list-open';open.setAttribute('aria-label','Open chat with '+name);open.setAttribute('aria-current',c.id===activeId?'true':'false');open.innerHTML='<span class="avatar-wrap">'+(c.is_group?'<span class="user-avatar"><i aria-hidden="true" class="bi bi-people-fill"></i></span>':other?avatarHtml(other):'')+(!c.is_group&&other?'<span class="presence-dot presence-'+esc(status)+' presence-live-'+other.id+'"></span>':'')+'</span><span class="chat-list-copy"><span class="chat-list-name">'+esc(name)+(c.is_muted?' <i class="bi bi-bell-slash" title="Muted"></i>':'')+'</span><span class="chat-list-preview">'+esc(preview)+'</span></span><span class="chat-list-date">'+esc(stamp)+'</span>'+((unread.has(c.id)||c.is_unread)&&!c.is_muted?'<span class="chat-list-unread" aria-label="Unread"></span>':'');open.onclick=()=>onOpen(c.id);row.append(open);
    const more=document.createElement('button');more.type='button';more.className='chat-row-more';more.textContent='···';more.setAttribute('aria-label','Options for '+name);more.setAttribute('aria-haspopup','menu');more.onclick=()=>onMenu(more,c);row.append(more);list.append(row);
   }
  }
  draw();if(focused&&!search.hidden){search.focus();search.setSelectionRange?.(cursor,cursor)}
 }
 return {render};
};
