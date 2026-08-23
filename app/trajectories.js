(function(){
'use strict';

var data=window.TRAJECTORY_DATA;
var main=document.getElementById('replay');
var timeline=document.getElementById('timeline');
var placeholder=document.getElementById('trace-placeholder');
var finalSection=document.getElementById('final-section');
var answerStream=document.getElementById('answer-stream');
var continueBtn=document.getElementById('continue');
var playBtn=document.getElementById('play');
var footerPlay=document.getElementById('footer-play');
var modeNote=document.getElementById('mode-note');
var composerNote=document.getElementById('composer-note');
var answerState=document.getElementById('answer-state');
var dot=document.getElementById('dot');
var statusText=document.getElementById('statustext');

var params=new URLSearchParams(location.search);
var state={
  mode:params.get('mode')==='standard'?'standard':'unfold',
  token:0,
  running:false,
  waiting:false,
  buffered:0,
  scrollTransition:null,
  scrollLock:false,
  keyboardContinue:false,
  lastRevealAt:0,
  replay:null,
};

// The trace is already complete, but the answer is replayed as if generation
// and rendering were two separate clocks. Generation stays ahead; the viewer
// controls how much of that generated answer becomes visible.
var GENERATION_CPS=900;
var RENDER_CPS=720;
var REVEAL_CPS=900;

function escapeHtml(value){
  return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function markdown(value){
  if(!value)return '';
  var html=escapeHtml(value),blocks=[];
  html=html.replace(/```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g,function(_,content){
    blocks.push('<pre><code>'+content.replace(/\n$/,'')+'</code></pre>');
    return '\u0001'+(blocks.length-1)+'\u0001';
  });
  html=html.replace(/^###\s+(.+)$/gm,'<h3>$1</h3>').replace(/^##\s+(.+)$/gm,'<h2>$1</h2>').replace(/^#\s+(.+)$/gm,'<h1>$1</h1>');
  html=html.replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
  html=html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  html=html.replace(/\{\{cite:(\d+)\}\}/g,'<span class="citation">{{cite:$1}}</span>');
  var lines=html.split('\n'),out=[],list=null,paragraph=[];
  function flushParagraph(){if(paragraph.length){out.push('<p>'+paragraph.join('<br>')+'</p>');paragraph=[];}}
  function flushList(){if(list){out.push('</'+list+'>');list=null;}}
  lines.forEach(function(line){
    var hr=line.match(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/),unordered=line.match(/^\s*[-*+]\s+(.+)$/),ordered=line.match(/^\s*\d+\.\s+(.+)$/);
    if(hr){flushParagraph();flushList();out.push('<hr>');return;}
    if(unordered){flushParagraph();if(list!=='ul'){flushList();out.push('<ul>');list='ul';}out.push('<li>'+unordered[1]+'</li>');return;}
    if(ordered){flushParagraph();if(list!=='ol'){flushList();out.push('<ol>');list='ol';}out.push('<li>'+ordered[1]+'</li>');return;}
    flushList();
    if(/^\s*<(h\d|pre)/.test(line)||/^\u0001\d+\u0001$/.test(line)){flushParagraph();out.push(line);return;}
    if(!line.trim()){flushParagraph();return;}
    paragraph.push(line);
  });
  flushList();flushParagraph();
  return out.join('\n').replace(/\u0001(\d+)\u0001/g,function(_,index){return blocks[Number(index)];});
}

function markdownStreaming(value,reserveCitation){
  var pending=value.match(/\{\{cite:\d*$/);
  var html=pending?markdown(value.slice(0,-pending[0].length))+'<span class="citation citation-pending">'+escapeHtml(pending[0])+'</span>':markdown(value);
  if(reserveCitation){
    var reserve='<span class="citation citation-reserve" aria-hidden="true">&nbsp;</span>';
    if(/<\/p>$/.test(html))html=html.replace(/<\/p>$/g,reserve+'</p>');
    else html+=reserve;
  }
  return html;
}

function setStatus(text,live){
  statusText.textContent=text;
  dot.className='dot'+(live?' live':(text==='complete'?' ok':''));
}

function scrollLatest(instant){
  function move(){
    if(state.scrollLock){
      state.scrollTransition=null;
      main.scrollTop=main.scrollHeight;
      return;
    }
    var transition=state.scrollTransition;
    if(transition){
      var progress=Math.min(1,(performance.now()-transition.startedAt)/transition.duration);
      var eased=progress<1?progress*progress*(3-2*progress):1;
      var target=Math.max(0,main.scrollHeight-main.clientHeight);
      main.scrollTop=transition.start+(target-transition.start)*eased;
      if(progress>=1)state.scrollTransition=null;
      return;
    }
    main.scrollTop=main.scrollHeight;
  }
  if(instant)move();else requestAnimationFrame(move);
}

function beginScrollTransition(){
  state.scrollTransition={start:main.scrollTop,startedAt:performance.now(),duration:180};
}

function pause(ms,token){
  return new Promise(function(resolve){setTimeout(function(){resolve(token===state.token);},ms);});
}

function setMode(mode){
  state.mode=mode;
  document.querySelectorAll('.mode-button').forEach(function(button){
    var active=button.dataset.mode===mode;
    button.classList.toggle('active',active);
    button.setAttribute('aria-selected',String(active));
  });
  var unfold=mode==='unfold';
  modeNote.textContent=unfold?'Sections wait behind Continue':'One normal answer stream';
  composerNote.textContent=unfold?'Continue reveals sections; Catch up follows live generation.':'The final answer renders as one message.';
}

function updatePlayControls(){
  playBtn.disabled=state.running;
  playBtn.textContent=state.running?'Playing…':(finalSection.hidden?'Play replay':'Replay');
  footerPlay.textContent=state.running?'·':'↻';
  footerPlay.disabled=state.running;
  footerPlay.title=state.running?'Replay is playing':'Replay';
}

function clearContinue(){
  state.waiting=false;
  if(state.replay){
    if(state.replay.raf)cancelAnimationFrame(state.replay.raf);
    if(state.replay.resolve)state.replay.resolve(false);
    state.replay=null;
  }
  if(ucTimer){clearTimeout(ucTimer);ucTimer=null;}
  continueBtn.classList.remove('on','catch-up','pending');
  continueBtn.disabled=true;
}

function resetContent(){
  state.token++;
  state.running=false;
  state.buffered=0;
  state.scrollTransition=null;
  state.scrollLock=false;
  state.keyboardContinue=false;
  state.lastRevealAt=0;
  clearContinue();
  placeholder.hidden=false;
  timeline.querySelectorAll('.trace-entry').forEach(function(entry){entry.remove();});
  finalSection.hidden=true;
  answerStream.textContent='';
  answerState.textContent='waiting';
  setStatus('ready',false);
  updatePlayControls();
}

function togglePreamble(card){
  card.classList.toggle('collapsed');
  var button=card.querySelector('.preamble-head');
  button.setAttribute('aria-expanded',String(!card.classList.contains('collapsed')));
}

function makeEntry(index){
  var entry=document.createElement('article');entry.className='trace-entry live';entry.dataset.iteration=String(index+1);
  placeholder.hidden=true;
  timeline.appendChild(entry);scrollLatest(false);
  return entry;
}

function addPreamble(entry,iteration,index){
  if(!iteration.preamble)return;
  var card=document.createElement('div');card.className='preamble';
  var head=document.createElement('button');head.type='button';head.className='preamble-head';head.setAttribute('aria-expanded','true');
  var icon=document.createElement('span');icon.className='event-icon';icon.textContent='✦';
  var label=document.createElement('span');label.className='event-label';label.textContent='Assistant preamble';
  var summary=document.createElement('span');summary.className='event-summary';summary.textContent=iteration.tool.name+' · step '+(index+1);
  var disclosure=document.createElement('span');disclosure.className='disclosure';disclosure.textContent='⌄';
  head.append(icon,label,summary,disclosure);head.addEventListener('click',function(){togglePreamble(card);});
  var body=document.createElement('div');body.className='preamble-body';var code=document.createElement('pre');code.textContent=iteration.preamble;body.appendChild(code);
  card.append(head,body);entry.appendChild(card);scrollLatest(false);
}

function addTool(entry,iteration){
  var tool=iteration.tool,card=document.createElement('div');card.className='tool-card';
  var summary=document.createElement('button');summary.type='button';summary.className='tool-summary';summary.setAttribute('aria-expanded','false');
  var glyph=document.createElement('span');glyph.className='tool-glyph';glyph.textContent='⌘';
  var name=document.createElement('span');name.className='tool-name';name.textContent='Called tool';
  var meta=document.createElement('span');meta.className='tool-meta';meta.textContent=tool.name+' · '+tool.response;
  var disclosure=document.createElement('span');disclosure.className='disclosure';disclosure.textContent='⌄';
  summary.append(glyph,name,meta,disclosure);
  var detail=document.createElement('div');detail.className='tool-detail';
  var request=document.createElement('div');request.className='io-block';request.innerHTML='<div class="io-label">Request</div><code></code>';request.querySelector('code').textContent=tool.name+'('+tool.request+')';
  var response=document.createElement('div');response.className='io-block';response.innerHTML='<div class="io-label">Response</div><div class="result-copy"></div><div class="result-meta"></div>';response.querySelector('.result-copy').textContent=tool.detail;response.querySelector('.result-meta').textContent=tool.meta;
  detail.append(request,response);card.append(summary,detail);summary.addEventListener('click',function(){var open=card.classList.toggle('open');summary.setAttribute('aria-expanded',String(open));});
  if(!entry.querySelector('.preamble'))entry.classList.add('tool-only');
  entry.appendChild(card);entry.classList.remove('live');scrollLatest(false);
}

function collapsePreambles(){
  timeline.querySelectorAll('.preamble').forEach(function(card){
    card.classList.add('collapsed');
    card.querySelector('.preamble-head').setAttribute('aria-expanded','false');
  });
}

function showFinal(){
  collapsePreambles();
  finalSection.hidden=false;
  finalSection.classList.add('revealed');
  answerState.textContent=state.mode==='unfold'?'buffering sections':'streaming';
  scrollLatest(false);
}

function addAnswerRow(continuation){
  var row=document.createElement('article');row.className='answer-row'+(continuation?' continuation':'');
  var avatar=document.createElement('div');avatar.className='answer-avatar';avatar.textContent='✦';
  var content=document.createElement('div');content.className='answer-content';
  row.append(avatar,content);answerStream.appendChild(row);return content;
}

function typeInto(element,text,token){
  return new Promise(function(resolve){
    var shown=0,last=performance.now(),speed=560;
    function frame(now){
      if(token!==state.token){resolve(false);return;}
      var targetShown=Math.min(text.length,shown+Math.max(1,Math.floor((now-last)*speed/1000)));
      var nextCitation=text.indexOf('{{cite:',shown);
      if(nextCitation>shown&&nextCitation<=targetShown)targetShown=nextCitation;
      shown=targetShown;last=now;
      var prefix=text.slice(0,shown),reserveCitation=shown<text.length&&/^\{\{cite:\d+\}\}/.test(text.slice(shown));
      element.innerHTML=markdownStreaming(prefix,reserveCitation);scrollLatest(true);
      if(shown>=text.length){resolve(true);return;}
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

function answerChunks(text){
  var blocks=text.trim().split(/\n{2,}/),chunks=[];
  for(var i=0;i<blocks.length;i++){
    var block=blocks[i].trim();if(!block)continue;
    var next=blocks[i+1]&&blocks[i+1].trim();
    if(/^#{1,3}\s/.test(block)&&next){chunks.push(block+'\n\n'+next);i++;continue;}
    if(block.length<125&&next&&!/^#{1,3}\s/.test(next)){chunks.push(block+'\n\n'+next);i++;continue;}
    chunks.push(block);
  }
  return chunks;
}

function citationSafeLength(text,requested){
  var shown=Math.max(0,Math.min(text.length,Math.floor(requested))),cursor=0,start,end;
  while((start=text.indexOf('{{cite:',cursor))>=0){
    end=text.indexOf('}}',start+7);
    if(end<0)break;
    end+=2;
    if(start<shown&&shown<end){shown=start;break;}
    cursor=end;
  }
  return shown;
}

function renderReplayContent(replay){
  var text=replay.chunks[replay.visibleIndex],shown=citationSafeLength(text,replay.visibleChars);
  if(shown===replay.markupChars)return;
  replay.markupChars=shown;
  var prefix=text.slice(0,shown),reserveCitation=shown<text.length&&/^\{\{cite:\d+\}\}/.test(text.slice(shown));
  replay.visibleContent.innerHTML=markdownStreaming(prefix,reserveCitation);
  scrollLatest(true);
}

function advanceGeneration(replay,elapsed){
  var remainingMs=elapsed;
  while(remainingMs>0&&replay.generationIndex<replay.chunks.length){
    var index=replay.generationIndex,total=replay.chunks[index].length,left=total-replay.generated[index],available=remainingMs*GENERATION_CPS/1000,take=Math.min(left,available);
    replay.generated[index]+=take;
    remainingMs-=take*1000/GENERATION_CPS;
    if(replay.generated[index]>=total){
      replay.generated[index]=total;replay.generationIndex++;
    }
  }
}

function advanceReplayRenderer(replay,elapsed){
  if(replay.visibleComplete)return;
  var text=replay.chunks[replay.visibleIndex],target=Math.floor(replay.generated[replay.visibleIndex]);
  var speed=replay.liveRender?GENERATION_CPS:(replay.revealSpeed||RENDER_CPS);
  replay.visibleChars=Math.min(target,replay.visibleChars+elapsed*speed/1000);
  renderReplayContent(replay);
  if(replay.visibleChars>=text.length){
    replay.visibleChars=text.length;
    replay.visibleComplete=true;
    replay.liveRender=false;
    replay.revealSpeed=0;
    renderReplayContent(replay);
    scrollLatest(true);
  }
}

function bufferedSections(replay){
  var count=0;
  for(var i=replay.visibleIndex+1;i<replay.chunks.length;i++){
    if(replay.generated[i]>=replay.chunks[i].length)count++;
  }
  return count;
}

var ucTimer=null;
function applyContinueUI(show,behind){
  if(ucTimer){clearTimeout(ucTimer);ucTimer=null;}
  continueBtn.classList.toggle('on',show);continueBtn.classList.toggle('catch-up',behind);continueBtn.classList.remove('pending');continueBtn.disabled=!show;
}

function updateReplayControls(replay){
  var current=replay.visibleIndex,next=current+1,target=-1,mode='',visibleComplete=replay.visibleComplete;
  if(!visibleComplete&&current>0&&!replay.liveRender&&replay.generated[current]>replay.visibleChars+1){
    target=current;mode='catchup';
  }else if(visibleComplete&&next<replay.chunks.length&&replay.generated[next]>0){
    target=next;mode=replay.generated[next]<replay.chunks[next].length?'catchup':'continue';
  }
  var show=target>=0,wasWaiting=state.waiting;
  replay.buttonTarget=target;replay.buttonMode=mode;state.waiting=show;state.buffered=bufferedSections(replay);
  var uc=show&&mode==='catchup';
  if(continueBtn.classList.contains('on')!==!!show){applyContinueUI(show,uc);}
  else{if(ucTimer)clearTimeout(ucTimer);ucTimer=setTimeout(function(){applyContinueUI(show,uc);},180);}
  if(show!==wasWaiting)scrollLatest(false);

  var status,answer;
  if(!visibleComplete){status=replay.liveRender?'answer · rendering live':'answer · rendering';answer='rendering';}
  else if(show&&mode==='catchup'){status='answer · next section generating';answer='catch up';}
  else if(show){status='answer · '+state.buffered+' buffered';answer=state.buffered+' buffered';}
  else if(replay.generationIndex<replay.chunks.length){status='answer · generating next';answer='generating next';}
  else{status='answer · rendering';answer='rendering';}
  var indicator=status+'|'+answer;
  if(replay.indicator!==indicator){
    replay.indicator=indicator;answerState.textContent=answer;
    setStatus(status,!show&&answer!=='catch up'&&answer!=='0 buffered');
  }
}

function finishUnfoldReplay(replay,ok){
  if(replay.raf)cancelAnimationFrame(replay.raf);
  state.replay=null;state.waiting=false;state.buffered=0;
  if(ucTimer){clearTimeout(ucTimer);ucTimer=null;}
  continueBtn.classList.remove('on','catch-up','pending');continueBtn.disabled=true;
  replay.resolve(ok);
}

function unfoldFrame(replay,now){
  if(state.replay!==replay||replay.token!==state.token){finishUnfoldReplay(replay,false);return;}
  var elapsed=Math.min(80,Math.max(0,now-replay.lastFrame));replay.lastFrame=now;
  advanceGeneration(replay,elapsed);
  advanceReplayRenderer(replay,elapsed);
  updateReplayControls(replay);
  if(replay.visibleComplete&&replay.visibleIndex===replay.chunks.length-1&&replay.generationIndex===replay.chunks.length){
    answerState.textContent='complete';
    finishUnfoldReplay(replay,true);return;
  }
  replay.raf=requestAnimationFrame(function(frameNow){unfoldFrame(replay,frameNow);});
}

function revealUnfold(){
  var replay=state.replay;
  if(!replay||replay.buttonTarget<0)return;
  var target=replay.buttonTarget,mode=replay.buttonMode;
  var now=performance.now(),rapid=state.keyboardContinue||now-state.lastRevealAt<320;
  state.scrollLock=state.scrollLock||rapid;
  state.keyboardContinue=false;state.lastRevealAt=now;
  replay.buttonTarget=-1;replay.buttonMode='';
  state.waiting=false;if(ucTimer){clearTimeout(ucTimer);ucTimer=null;}continueBtn.classList.remove('on','catch-up','pending');continueBtn.disabled=true;
  if(target!==replay.visibleIndex){
    replay.visibleIndex=target;replay.visibleContent=addAnswerRow(true);replay.visibleChars=0;replay.visibleComplete=false;replay.markupChars=-1;
    if(!state.scrollLock)beginScrollTransition();else state.scrollTransition=null;
  }
  if(mode==='catchup'){
    replay.visibleChars=Math.floor(replay.generated[target]);
    replay.liveRender=true;
  }else{
    replay.liveRender=false;
  }
  replay.revealSpeed=REVEAL_CPS;
  renderReplayContent(replay);answerState.textContent='rendering';setStatus('answer · rendering',true);updateReplayControls(replay);scrollLatest(true);
}

async function runStandard(token){
  var content=addAnswerRow(false),ok=await typeInto(content,data.finalAnswer,token);
  if(!ok)return false;
  content.innerHTML=markdown(data.finalAnswer);answerState.textContent='complete';scrollLatest(true);return true;
}

function runUnfold(token){
  var chunks=answerChunks(data.finalAnswer);
  return new Promise(function(resolve){
    var replay={token:token,chunks:chunks,generated:chunks.map(function(){return 0;}),generationIndex:0,visibleIndex:0,visibleContent:addAnswerRow(false),visibleChars:0,visibleComplete:false,liveRender:false,revealSpeed:0,markupChars:-1,buttonTarget:-1,buttonMode:'',indicator:'',lastFrame:performance.now(),raf:0,resolve:resolve};
    state.replay=replay;answerState.textContent='rendering';setStatus('answer · rendering',true);
    replay.raf=requestAnimationFrame(function(now){unfoldFrame(replay,now);});
  });
}

async function play(){
  if(state.running)return;
  resetContent();
  var token=state.token;state.running=true;updatePlayControls();setStatus('replaying · 0/'+data.iterations.length,true);
  var valid=await pause(180,token);if(!valid)return;
  for(var i=0;i<data.iterations.length;i++){
    if(token!==state.token)return;
    setStatus('replaying · '+(i+1)+'/'+data.iterations.length,true);
    var entry=makeEntry(i);
    addPreamble(entry,data.iterations[i],i);
    valid=await pause(data.iterations[i].preamble?220:80,token);if(!valid)return;
    addTool(entry,data.iterations[i]);
    valid=await pause(280,token);if(!valid)return;
  }
  if(token!==state.token)return;
  setStatus('final answer · starting',true);showFinal();
  valid=await pause(260,token);if(!valid)return;
  var finished=state.mode==='unfold'?await runUnfold(token):await runStandard(token);
  if(!finished)return;
  state.running=false;state.buffered=0;setStatus('complete',false);updatePlayControls();
  scrollLatest(true);
}

continueBtn.addEventListener('click',function(){if(state.waiting)revealUnfold();});
playBtn.addEventListener('click',play);footerPlay.addEventListener('click',play);
document.querySelectorAll('.mode-button').forEach(function(button){button.addEventListener('click',function(){if(state.running)return;setMode(button.dataset.mode);resetContent();});});
document.addEventListener('keydown',function(event){if(event.key==='Enter'&&!event.shiftKey&&state.waiting){event.preventDefault();state.keyboardContinue=true;continueBtn.click();}});

document.getElementById('trajectory-title').textContent=data.title;
document.getElementById('prompt').textContent=data.prompt;
document.getElementById('source-link').textContent=data.source;
document.getElementById('source-link').href=data.sourceUrl;
document.getElementById('trace-model').textContent=data.model;
document.getElementById('trace-stats').textContent=data.stats.toolCalls+' tool calls · '+data.stats.finalCharacters.toLocaleString()+' answer characters';
document.getElementById('trace-count').textContent=data.iterations.length+' tool calls'+(data.stats.preambles?' · '+data.stats.preambles+' preambles':'');
setMode(state.mode);updatePlayControls();
if(params.has('autoplay'))setTimeout(play,260);
})();
