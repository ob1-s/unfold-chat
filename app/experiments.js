(function(){
'use strict';

var mixed=document.body.dataset.experiment==='mixed';
var presentation=mixed?'speculative':'full';
var chat=document.getElementById('chat'),input=document.getElementById('input'),sendBtn=document.getElementById('send'),guidedInput=document.getElementById('guided');
var continueBtn=document.getElementById('continue'),dot=document.getElementById('dot'),statusText=document.getElementById('statustext');
var annotationPanel=document.getElementById('annotation-panel'),annotationList=document.getElementById('annotation-list'),annotationCount=document.getElementById('annotation-count');
var selectionTray=document.getElementById('selection-tray'),selectionQuote=document.getElementById('selection-quote'),annotationInput=document.getElementById('annotation-input');
var addAnnotationBtn=document.getElementById('add-annotation'),cancelSelectionBtn=document.getElementById('cancel-selection'),respondBtn=document.getElementById('respond');

var ACKS=new Set(('yeah yep yup yea yes yesss ok okay k kk sure right exactly indeed true fair gotcha lol lmao haha hahaha ha hehe nice cool wow whoa ooh aah dope sick awesome noice thanks thx oh ah hm mm mhm mhmm uhuh interesting aight bet').split(' '));
function isAck(text){
  var t=text.trim().toLowerCase().replace(/[.,!?;:'"()\[\]{}]+/g,' ').replace(/\s+/g,' ').trim();
  if(!t)return false;
  if(ACKS.has(t))return true;
  if(/^(i see|got it|makes sense|that makes sense|fair enough|sounds good|oh+ (ok|okay|yeah)|yeah+|yep+|ok+|ha+|lol+|lmao+)$/.test(t))return true;
  var words=t.split(' ');return words.length<=3&&words.every(function(w){return ACKS.has(w);});
}

var state={
  turnId:null,
  timeline:[],
  streamCtrl:null,
  generating:false,
  continuePending:false,
  hidden:0,
  current:null,
  lastAssistant:false,
  cps:0,
  sessionId:(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random()),
  sessionSeq:0,
  turnEnded:false,
  guided:false,
  annotations:[],
  pendingSelection:null,
};

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function md(s){
  if(!s)return '';
  var h=esc(s),blocks=[];
  h=h.replace(/```([\s\S]*?)```/g,function(_,c){blocks.push('<pre><code>'+c.replace(/\n$/,'')+'</code></pre>');return '\u0001'+(blocks.length-1)+'\u0001';});
  h=h.replace(/^###\s+(.+)$/gm,'<h3>$1</h3>').replace(/^##\s+(.+)$/gm,'<h2>$1</h2>').replace(/^#\s+(.+)$/gm,'<h1>$1</h1>');
  h=h.replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
  h=h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  var lines=h.split('\n'),out=[],list=null,para=[];
  function flushPara(){if(para.length){out.push('<p>'+para.join('<br>')+'</p>');para=[];}}
  function flushList(){if(list){out.push('</'+list+'>');list=null;}}
  lines.forEach(function(line){
    var hr=line.match(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/);
    var u=line.match(/^\s*[-*+]\s+(.+)$/),o=line.match(/^\s*\d+\.\s+(.+)$/);
    if(hr){flushPara();flushList();out.push('<hr>');return;}
    if(u){flushPara();if(list!=='ul'){flushList();out.push('<ul>');list='ul';}out.push('<li>'+u[1]+'</li>');return;}
    if(o){flushPara();if(list!=='ol'){flushList();out.push('<ol>');list='ol';}out.push('<li>'+o[1]+'</li>');return;}
    flushList();
    if(/^\s*<(h\d|pre)/.test(line)||/^\u0001\d+\u0001$/.test(line)){flushPara();out.push(line);return;}
    if(!line.trim()){flushPara();return;}
    para.push(line);
  });
  flushList();flushPara();
  return out.join('\n').replace(/\u0001(\d+)\u0001/g,function(_,i){return blocks[+i];});
}

function scrollDown(){chat.scrollTop=chat.scrollHeight;}
function setStatus(text,live){statusText.textContent=text;dot.className='dot'+(live?' live':(text==='complete'?' ok':''));}
function row(role,text,ack){
  var empty=document.getElementById('empty');if(empty)empty.remove();
  var r=document.createElement('div');r.className='row '+(ack?'ack':role);
  if(role==='assistant'){
    var av=document.createElement('div');av.className='avatar';av.textContent='✦';r.appendChild(av);
  }
  var box=document.createElement('div');box.className='message';
  var content=document.createElement('div');content.className='message-text';content.innerHTML=md(text||'');box.appendChild(content);r.appendChild(box);chat.appendChild(r);scrollDown();
  return {row:r,msg:content};
}
function addTimeline(role,content){if(content)state.timeline.push({role:role,content:content});}
function addUser(content,display,ack){row('user',display||content,ack);addTimeline('user',content);state.lastAssistant=false;}
function newAssistantSegment(){
  var r=row('assistant','',false);if(state.lastAssistant)r.row.classList.add('continuation');
  r.row.dataset.chunk=String(state.current.index);state.lastAssistant=true;return r;
}
function ensureCurrentElement(){var c=state.current;if(!c)return null;if(!c.node)c.node=newAssistantSegment();return c.node.msg;}
function renderCurrent(){
  var c=state.current;if(!c||!c.node)return;
  var local=c.rendered.slice(c.segmentStart),tail='';
  if(!c.finalized)tail=local?'<span class="caret"></span>':'<span class="typing"><i></i><i></i><i></i></span>';
  c.node.msg.innerHTML=md(local)+tail;scrollDown();
}
function commitRenderedPrefix(){
  var c=state.current;if(!c)return;
  var local=c.rendered.slice(c.segmentStart);
  if(local){ensureCurrentElement();c.node.msg.innerHTML=md(local);addTimeline('assistant',local);c.segmentStart=c.rendered.length;c.node=null;}
  else if(c.node){c.node.row.remove();c.node=null;}
}
function stopReplay(){var c=state.current;if(c&&c.raf){cancelAnimationFrame(c.raf);c.raf=0;}}
function replayFrame(ts){
  var c=state.current;if(!c||!c.replaying)return;
  if(!c.replayStartAt){c.replayStartAt=ts;c.replayBaseLen=c.rendered.length;}
  var cps=c.replayCps||state.cps||180,want=Math.min(c.target.length,c.replayBaseLen+Math.floor(cps*(ts-c.replayStartAt)/1000));
  if(want>c.rendered.length){c.rendered=c.target.slice(0,want);ensureCurrentElement();renderCurrent();}
  if(c.rendered.length>=c.target.length){
    c.replaying=false;c.replayStartAt=0;c.replayBaseLen=c.rendered.length;
    if(c.ended)finishCurrentChunk();
    return;
  }
  c.raf=requestAnimationFrame(replayFrame);
}
function startReplay(){var c=state.current;if(!c||c.replaying)return;c.replaying=true;c.replayStartAt=0;c.replayBaseLen=c.rendered.length;c.replayCps=state.cps||c.replayCps||180;c.raf=requestAnimationFrame(replayFrame);}
function catchUpCurrent(){
  var c=state.current;if(!c||c.rendered.length>=c.target.length&&!c.replaying)return false;
  stopReplay();c.replaying=false;c.replayStartAt=0;c.replayBaseLen=c.target.length;c.rendered=c.target;ensureCurrentElement();renderCurrent();
  if(c.ended)finishCurrentChunk();else updateContinue();
  return true;
}
function finishCurrentChunk(){
  var c=state.current;if(!c||c.finalized||c.rendered.length<c.target.length)return;
  c.finalized=true;stopReplay();var local=c.rendered.slice(c.segmentStart);
  if(local){ensureCurrentElement();c.node.msg.innerHTML=md(local);addTimeline('assistant',local);}else if(c.node)c.node.row.remove();
  state.current=null;state.lastAssistant=true;scrollDown();if(state.turnEnded&&state.hidden===0)setStatus('complete',false);updateContinue();
}
function abandonCurrent(){var c=state.current;if(!c)return;stopReplay();commitRenderedPrefix();if(c.node)c.node.row.remove();state.current=null;}

function onChunkOpen(d){
  if(state.current&&state.current.index!==d.index)finishCurrentChunk();
  if(Number(d.cps)>0)state.cps=Number(d.cps);
  var initial=String(d.initial||'');
  state.current={index:d.index,target:initial,rendered:'',segmentStart:0,node:null,ended:false,finalized:false,replaying:false,raf:0,replayStartAt:0,replayBaseLen:0,replayCps:state.cps||180,paint:0};
  state.continuePending=false;updateContinue();ensureCurrentElement();if(initial)startReplay();else renderCurrent();
}
function onDelta(d){
  var c=state.current;if(!c||c.index!==d.index){onChunkOpen({index:d.index,initial:'',cps:d.cps});c=state.current;}
  if(Number(d.cps)>0)state.cps=Number(d.cps);c.target+=String(d.t||'');if(c.replaying)return;
  c.rendered=c.target;ensureCurrentElement();if(!c.paint)c.paint=requestAnimationFrame(function(){if(state.current===c){c.paint=0;renderCurrent();}});
}
function onChunkEnd(d){var c=state.current;if(!c||c.index!==d.index)return;c.ended=true;if(c.replaying||c.rendered.length<c.target.length){startReplay();return;}finishCurrentChunk();}

function updateContinue(){
  if(!continueBtn)return;
  var c=state.current,behind=!!(c&&c.rendered.length<c.target.length),canContinue=!state.turnEnded&&state.hidden>0,show=!!state.turnId&&(behind||canContinue);
  continueBtn.classList.toggle('on',show);continueBtn.classList.toggle('catch-up',behind);continueBtn.classList.toggle('pending',state.continuePending&&!behind);continueBtn.disabled=!show;
}
function handleEvent(d){
  if(d.type==='turn'){state.turnId=d.turnId;state.generating=true;state.turnEnded=false;setStatus('generating…',true);return;}
  if(d.type==='chunk_open'){onChunkOpen(d);return;}
  if(d.type==='delta'){onDelta(d);return;}
  if(d.type==='chunk_end'){onChunkEnd(d);return;}
  if(d.type==='state'){
    state.generating=!!d.generating;state.hidden=Number(d.hidden||0);state.continuePending=!!d.waiting;if(Number(d.cps)>0)state.cps=Number(d.cps);
    if(state.generating)setStatus(state.hidden?'generating · '+state.hidden+' buffered':'generating…',true);else if(state.hidden)setStatus(state.hidden+' buffered',false);updateContinue();return;
  }
  if(d.type==='generation_end'){state.generating=false;state.hidden=Number(d.hidden||0);if(Number(d.cps)>0)state.cps=Number(d.cps);setStatus(state.hidden?state.hidden+' buffered':'complete',false);updateContinue();return;}
  if(d.type==='turn_end'){
    state.generating=false;state.continuePending=false;state.turnEnded=d.status==='done';
    if(d.status==='error')setStatus('error: '+(d.error||'generation failed'),false);else if(d.status!=='superseded'&&!state.current)setStatus('complete',false);updateContinue();
  }
}
function consumeSse(response,ctrl){
  if(!response.ok||!response.body)throw new Error('stream HTTP '+response.status);
  var reader=response.body.getReader(),dec=new TextDecoder(),buf='';
  function pump(){return reader.read().then(function(x){
    if(x.done)return;
    buf+=dec.decode(x.value,{stream:true});var split;
    while((split=buf.indexOf('\n\n'))>=0){
      var frame=buf.slice(0,split);buf=buf.slice(split+2);var data=frame.split(/\r?\n/).filter(function(l){return l.indexOf('data:')===0;}).map(function(l){return l.slice(5).replace(/^ /,'');}).join('\n');
      if(data)handleEvent(JSON.parse(data));
    }
    return pump();
  });}
  return pump();
}

function startInference(supersedeId){
  if(state.streamCtrl)state.streamCtrl.abort();
  var ctrl=new AbortController();state.streamCtrl=ctrl;state.turnId=null;state.generating=true;state.hidden=0;state.continuePending=false;state.lastAssistant=false;state.turnEnded=false;updateContinue();setStatus('connecting…',true);state.sessionSeq++;
  fetch('/api/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({history:state.timeline,presentation:presentation,guided:state.guided,supersede:supersedeId||null,sessionId:state.sessionId,sessionSeq:state.sessionSeq}),signal:ctrl.signal}).then(function(r){return consumeSse(r,ctrl);}).catch(function(e){if(ctrl.signal.aborted)return;state.generating=false;updateContinue();setStatus('request failed: '+e.message,false);});
}
function requestContinue(){
  if(!continueBtn||!state.turnId||state.continuePending)return;
  state.continuePending=true;updateContinue();
  fetch('/api/turns/'+state.turnId+'/continue',{method:'POST'}).then(function(r){return r.json();}).then(function(d){if(d.error){state.continuePending=false;updateContinue();setStatus('continue failed: '+d.error,false);return;}state.continuePending=!!d.waiting;updateContinue();}).catch(function(e){state.continuePending=false;updateContinue();setStatus('continue failed: '+e.message,false);});
}
function doContinue(){if(!mixed||!state.turnId)return;if(catchUpCurrent())return;requestContinue();}

function annotationPrompt(){
  return state.annotations.map(function(a){return '“'+a.quote+'”\n'+a.note;}).join('\n\n');
}
function annotationDisplay(text){var n=state.annotations.length;return text?text+'\n\n↳ '+n+' annotation'+(n===1?'':'s')+' attached':'Respond to '+n+' annotation'+(n===1?'':'s');}
function clearAnnotations(){state.annotations=[];state.pendingSelection=null;selectionTray.hidden=true;annotationInput.value='';renderAnnotations();}
function startFresh(content,display){
  var old=state.turnId;if(state.current)commitRenderedPrefix();addUser(content,display||content,false);clearAnnotations();abandonCurrent();if(state.streamCtrl)state.streamCtrl.abort();startInference(old);
}
function sendText(value){
  var text=value.trim();if(!text){doContinue();return;}
  if(mixed&&isAck(text)&&!!state.turnId&&!state.turnEnded&&!state.annotations.length){
    if(state.current)commitRenderedPrefix();addUser(text,text,true);if(state.current){state.current.node=null;state.current.segmentStart=state.current.rendered.length;}if(state.hidden>0||state.generating)doContinue();input.value='';input.style.height='auto';return;
  }
  var content=state.annotations.length?text+'\n\n'+annotationPrompt():text;startFresh(content,state.annotations.length?annotationDisplay(text):text);input.value='';input.style.height='auto';
}

function elementForNode(node){return node&&node.nodeType===1?node:node&&node.parentElement;}
function captureSelection(){
  var selection=window.getSelection();if(!selection||selection.rangeCount===0||selection.isCollapsed)return;
  var range=selection.getRangeAt(0),anchor=elementForNode(selection.anchorNode),focus=elementForNode(selection.focusNode),message=anchor&&anchor.closest('.message-text');
  if(!message||!message.contains(focus)||!message.contains(range.commonAncestorContainer))return;
  var quote=selection.toString().trim();if(!quote)return;
  state.pendingSelection={quote:quote,chunk:message.closest('.row').dataset.chunk};selectionQuote.textContent='“'+quote+'”';selectionTray.hidden=false;annotationInput.value='';annotationInput.focus();
}
function hideSelection(){state.pendingSelection=null;selectionTray.hidden=true;annotationInput.value='';}
function addAnnotation(){var note=annotationInput.value.trim();if(!state.pendingSelection||!note)return;state.annotations.push({quote:state.pendingSelection.quote,note:note,chunk:state.pendingSelection.chunk});hideSelection();renderAnnotations();window.getSelection().removeAllRanges();}
function renderAnnotations(){
  if(!annotationPanel)return;
  annotationPanel.hidden=!state.annotations.length;annotationCount.textContent=String(state.annotations.length);annotationList.textContent='';
  state.annotations.forEach(function(a,index){
    var card=document.createElement('article');card.className='annotation-card';card.title='Click to expand';
    var number=document.createElement('span');number.className='annotation-index';number.textContent=String(index+1);
    var quote=document.createElement('blockquote');quote.textContent=a.quote;
    var note=document.createElement('p');note.textContent=a.note;
    var remove=document.createElement('button');remove.className='annotation-remove';remove.type='button';remove.title='Remove annotation';remove.textContent='×';
    card.addEventListener('click',function(){annotationList.querySelectorAll('.annotation-card.expanded').forEach(function(other){if(other!==card)other.classList.remove('expanded');});card.classList.toggle('expanded');});
    remove.addEventListener('click',function(e){e.stopPropagation();state.annotations.splice(index,1);renderAnnotations();});
    card.append(number,quote,note,remove);annotationList.appendChild(card);
  });
}

if(continueBtn)continueBtn.addEventListener('click',doContinue);
guidedInput.addEventListener('change',function(){state.guided=guidedInput.checked;});
sendBtn.addEventListener('click',function(){sendText(input.value);});
input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendText(input.value);}});
input.addEventListener('input',function(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,150)+'px';});
if(addAnnotationBtn)addAnnotationBtn.addEventListener('click',addAnnotation);
if(cancelSelectionBtn)cancelSelectionBtn.addEventListener('click',hideSelection);
if(respondBtn)respondBtn.addEventListener('click',function(){if(state.annotations.length)startFresh(annotationPrompt(),annotationDisplay(''));});
chat.addEventListener('mouseup',function(){setTimeout(captureSelection,0);});
chat.addEventListener('keyup',captureSelection);
annotationInput.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();addAnnotation();}});
input.focus();
})();
