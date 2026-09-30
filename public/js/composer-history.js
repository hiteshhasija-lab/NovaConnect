// Recall only the current user's loaded messages in the active conversation.
window.createComposerHistory = function(input, getContext) {
  let scope=null, entries=[], index=-1, draft='';
  function reset(){ scope=null;entries=[];index=-1;draft=''; }
  input.addEventListener('input', reset);
  function handle(e){
    if(!['ArrowUp','ArrowDown'].includes(e.key)||e.isComposing||e.shiftKey||e.ctrlKey||e.metaKey||e.altKey)return false;
    const context=getContext();
    if(!context.scope)return false;
    if(scope!==context.scope){reset();scope=context.scope;}
    if(input.selectionStart!==input.selectionEnd)return false;
    if(index<0){
      if(e.key!=='ArrowUp'||input.selectionStart!==0)return false;
      entries=(context.messages||[]).filter(m=>Number(m.author?.id??m.user_id)===Number(context.userId)&&!m.deleted&&!m.metadata?.system&&typeof m.body==='string'&&m.body.trim()).slice().sort((a,b)=>Number(b.id)-Number(a.id)).map(m=>m.body);
      if(!entries.length)return false;
      draft=input.value;
    }else if(e.key==='ArrowUp'&&input.selectionStart!==0)return false;
    else if(e.key==='ArrowDown'&&input.selectionEnd!==input.value.length)return false;
    e.preventDefault();
    index=e.key==='ArrowUp'?Math.min(index+1,entries.length-1):index-1;
    input.value=index<0?draft:entries[index];
    const caret=e.key==='ArrowUp'?0:input.value.length;
    input.setSelectionRange(caret,caret);
    input.style.height='auto';input.style.height=Math.min(input.scrollHeight,128)+'px';
    return true;
  }
  return {handle,reset};
};
