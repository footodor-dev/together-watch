/* Together — browser client. Rooms and playback are synchronized by Socket.IO. */
'use strict';
const $ = id => document.getElementById(id);
const socket = io({ reconnection: true, reconnectionDelayMax: 4000 });
let roomId = new URLSearchParams(location.search).get('room')?.toUpperCase() || '';
let nickname = localStorage.getItem('together:nickname') || '';
let joined = false;
let myId = '';
let state = null;
let currentRevision = -1;
let currentMedia = null;
let lastAppliedSyncAt = 0;
let ignoringPlaybackUntil = 0;
let ytPlayer = null;
let ytReadyPromise = null;
let ytReady = false;
let loadedYoutubeId = '';
let hlsInstance = null;
let localStream = null;
let screenStream = null;
let peers = new Map();
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
let lastYouTubeSample = null;
let toastTimer = null;
let sharingBusy = false;
let vimeoPlayer = null;
let vimeoReady = false;
let vimeoId = '';
let vimeoPromise = null;
let clockOffset = 0;
let clockCalibrated = false;
let draggingTimeline = false;
let unread = 0;
let lastVimeoSeekAt = 0;

const urlInput = $('videoUrl');
const directPlayer = $('directPlayer');
const screenPlayer = $('screenPlayer');
const chatScroll = $('chatScroll');
const youtubeWrap = $('youtubeWrap');
const vimeoWrap = $('vimeoWrap');

$('nickInput').value = nickname;
if (roomId) {
  $('joinTitle').innerHTML = 'Вход в<br><em>комнату просмотра.</em>';
  $('joinDescription').textContent = `Комната ${roomId}. Укажите имя, чтобы присоединиться к просмотру.`;
  $('joinAction').textContent = 'Присоединиться';
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}
function hint(message) {
  $('inputHint').textContent = message;
  if (message) setTimeout(() => { if ($('inputHint').textContent === message) $('inputHint').textContent = ''; }, 7000);
}
function safeText(element, value) { element.textContent = value == null ? '' : String(value); }
function inviteUrl() { return `${location.origin}/?room=${encodeURIComponent(roomId)}`; }
function setPresence(on) {
  $('statusText').textContent = on ? 'Вы на связи' : 'Нет соединения';
  $('syncStatus').innerHTML = on ? '<span class="green-dot"></span> Синхронизация включена' : 'Подключаемся…';
}
function initials(name) { return [...(name || '?')][0].toUpperCase(); }
function addDom(parent, tag, cls, content) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (content !== undefined) el.textContent = content;
  parent.appendChild(el);
  return el;
}
function youtubeIdFromUrl(input) {
  try {
    const u = new URL(input);
    const h = u.hostname.toLowerCase();
    if (['youtu.be', 'www.youtu.be'].includes(h)) return u.pathname.split('/')[1];
    if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','www.youtube-nocookie.com','youtube-nocookie.com'].includes(h)) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const parts = u.pathname.split('/').filter(Boolean);
      if (['shorts','embed','live','v'].includes(parts[0])) return parts[1];
    }
  } catch (_) { return null; }
  return null;
}
function parseSource(input) {
  const trimmed = input.trim();
  const id = youtubeIdFromUrl(trimmed);
  if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return { kind: 'youtube', videoId: id };
  try {
    const u = new URL(trimmed);
    if (['vimeo.com','www.vimeo.com','player.vimeo.com'].includes(u.hostname.toLowerCase())) {
      const match = u.pathname.match(/(?:^\/video\/|^\/)([0-9]{6,14})(?:\/|$)/);
      if (match) return { kind: 'vimeo', videoId: match[1] };
    }
  } catch (_) {}
  try {
    const u = new URL(trimmed);
    if (['https:', 'http:'].includes(u.protocol) && /\.(mp4|webm|ogg|m3u8)(?:$|[?#])/i.test(u.href)) return { kind: 'direct', url: u.href };
  } catch (_) { /* handled below */ }
  return null;
}
function calculatedTime(media) {
  return Math.max(0, Number(media.position || 0) + (media.playing ? (Date.now() + clockOffset - media.updatedAt) / 1000 : 0));
}
function setActivePlayer(kind) {
  $('emptyPlayer').classList.toggle('hidden', kind !== 'none');
  youtubeWrap.classList.toggle('hidden', kind !== 'youtube');
  vimeoWrap.classList.toggle('hidden', kind !== 'vimeo');
  directPlayer.classList.toggle('hidden', kind !== 'direct');
  screenPlayer.classList.toggle('hidden', kind !== 'screen');
  $('screenWaiting').classList.toggle('hidden', kind !== 'waiting');
  $('playerBadge').classList.toggle('hidden', kind === 'youtube' || kind === 'vimeo' || kind === 'direct');
  if (kind !== 'youtube' && kind !== 'vimeo' && kind !== 'direct') $('videoUnlock').classList.add('hidden');
  $('transport').classList.toggle('disabled', !['youtube','vimeo','direct'].includes(kind));
  $('videoSound').disabled = !['youtube','vimeo','direct','screen'].includes(kind);
  $('globalPlay').disabled = !['youtube','vimeo','direct'].includes(kind);
  $('timelineSeek').disabled = !['youtube','vimeo','direct'].includes(kind);
}
function suppressControls(ms = 1500) { ignoringPlaybackUntil = Math.max(ignoringPlaybackUntil, Date.now() + ms); }
function ignoreControls() { return Date.now() < ignoringPlaybackUntil; }
function stopVideoSources() {
  suppressControls();
  directPlayer.pause();
  directPlayer.removeAttribute('src');
  directPlayer.load();
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  if (ytPlayer && ytReady) { try { ytPlayer.stopVideo(); } catch (_) {} }
  if (vimeoPlayer) { vimeoPlayer.destroy().catch(() => {}); vimeoPlayer = null; vimeoReady = false; vimeoId = ''; vimeoPromise = null; $('vimeoPlayer').replaceChildren(); }
  lastYouTubeSample = null;
}

function startYouTubeAPI() {
  if (ytReadyPromise) return ytReadyPromise;
  ytReadyPromise = new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; reject(new Error('YouTube не загрузился. Проверьте интернет или блокировщик рекламы.')); } }, 14000);
    window.onYouTubeIframeAPIReady = () => {
      ytPlayer = new YT.Player('ytPlayer', {
        width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, fs: 0, origin: location.origin },
        events: {
          onReady: () => { ytReady = true; if (!settled) { settled = true; clearTimeout(t); resolve(ytPlayer); } },
          onStateChange: onYTStateChange,
          onError: e => { hint(`YouTube не разрешает воспроизводить это видео (код ${e.data}). Выберите другое.`); }
        }
      });
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { if (!settled) { settled = true; clearTimeout(t); reject(new Error('Не удалось загрузить YouTube Player API.')); } };
    document.head.appendChild(script);
  });
  return ytReadyPromise;
}
function onYTStateChange(event) {
  if (ignoreControls() || !joined || currentMedia?.kind !== 'youtube') return;
  if (event.data === YT.PlayerState.PLAYING) {
    $('videoUnlock').classList.add('hidden');
    if (!currentMedia.playing) sendControl('play', ytPlayer.getCurrentTime());
  } else if (event.data === YT.PlayerState.PAUSED && currentMedia.playing) {
    sendControl('pause', ytPlayer.getCurrentTime());
  } else if (event.data === YT.PlayerState.ENDED && currentMedia.playing) {
    sendControl('pause', ytPlayer.getCurrentTime());
  }
}
async function loadYoutube(media) {
  try {
    await startYouTubeAPI();
    if (currentMedia?.kind !== 'youtube' || currentMedia.videoId !== media.videoId) return;
    loadedYoutubeId = media.videoId;
    suppressControls(1800);
    ytPlayer.cueVideoById({ videoId: media.videoId, startSeconds: calculatedTime(media) });
    setTimeout(() => { if (currentMedia?.kind === 'youtube' && currentMedia.videoId === media.videoId) syncPlayback(currentMedia, true); }, 500);
  } catch (e) { hint(e.message); toast('Ошибка загрузки YouTube'); }
}
async function loadVimeo(media) {
  try {
    if (!window.Vimeo?.Player) {
      if (!vimeoPromise) vimeoPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://player.vimeo.com/api/player.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Не удалось загрузить Vimeo Player SDK.'));
        document.head.appendChild(script);
      });
      await vimeoPromise;
    }
    if (currentMedia?.revision !== media.revision || currentMedia?.kind !== 'vimeo') return;
    vimeoId = media.videoId;
    vimeoPlayer = new Vimeo.Player('vimeoPlayer', { id: Number(media.videoId), responsive: true, autopause: false, playsinline: true, controls: false, fullscreen: false });
    await vimeoPlayer.ready();
    if (currentMedia?.revision !== media.revision) return;
    vimeoReady = true;
    suppressControls(1800);
    vimeoPlayer.on('play', async () => {
      if (!ignoreControls() && currentMedia?.kind === 'vimeo' && !currentMedia.playing) sendControl('play', await vimeoPlayer.getCurrentTime());
    });
    vimeoPlayer.on('pause', async () => {
      if (!ignoreControls() && currentMedia?.kind === 'vimeo' && currentMedia.playing) sendControl('pause', await vimeoPlayer.getCurrentTime());
    });
    vimeoPlayer.on('seeked', data => {
      if (!ignoreControls() && currentMedia?.kind === 'vimeo' && Date.now() - lastVimeoSeekAt > 350) {
        lastVimeoSeekAt = Date.now();
        sendControl('seek', data.seconds);
      }
    });
    syncPlayback(currentMedia, true);
  } catch (e) { hint('Vimeo не загрузился. Возможно, автор запретил встраивание видео.'); console.warn(e); }
}
function loadHls(url) {
  if (directPlayer.canPlayType('application/vnd.apple.mpegurl')) { directPlayer.src = url; return; }
  if (window.Hls?.isSupported()) {
    hlsInstance = new Hls();
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(directPlayer);
    hlsInstance.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) hint('Не удалось открыть поток. Проверьте URL и разрешение сайта на воспроизведение.'); });
    return;
  }
  const js = document.createElement('script');
  js.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js';
  js.onload = () => { if (currentMedia?.kind === 'direct' && currentMedia.url === url) loadHls(url); };
  js.onerror = () => hint('Не удалось загрузить плеер для HLS.');
  document.head.appendChild(js);
}
function loadDirect(media) {
  suppressControls();
  if (/\.m3u8(?:$|[?#])/i.test(media.url)) loadHls(media.url);
  else directPlayer.src = media.url;
  directPlayer.load();
  directPlayer.addEventListener('loadedmetadata', () => {
    if (currentMedia?.revision === media.revision) syncPlayback(currentMedia, true);
  }, { once: true });
  directPlayer.addEventListener('error', () => {
    if (currentMedia?.revision === media.revision) hint('Не удалось открыть видео. Сайт может запрещать внешнее воспроизведение или CORS.');
  }, { once: true });
}
function showUnlock() { $('videoUnlock').classList.remove('hidden'); }
function syncPlayback(media, force = false) {
  if (!media || !['youtube', 'vimeo', 'direct'].includes(media.kind)) return;
  const target = calculatedTime(media);
  if (media.kind === 'youtube') {
    if (!ytReady || loadedYoutubeId !== media.videoId) return;
    try {
      const current = ytPlayer.getCurrentTime();
      if (Number.isFinite(current) && Math.abs(current - target) > (force ? .55 : 1.25)) { suppressControls(950); ytPlayer.seekTo(target, true); }
      const status = ytPlayer.getPlayerState();
      if (media.playing && status !== YT.PlayerState.PLAYING && status !== YT.PlayerState.BUFFERING) {
        suppressControls(950); ytPlayer.playVideo();
        setTimeout(() => {
          if (currentMedia?.kind === 'youtube' && currentMedia.playing && ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING && ytPlayer.getPlayerState() !== YT.PlayerState.BUFFERING) showUnlock();
        }, 1600);
      } else if (!media.playing && (status === YT.PlayerState.PLAYING || status === YT.PlayerState.BUFFERING)) { suppressControls(950); ytPlayer.pauseVideo(); }
    } catch (_) { /* an ad or delayed player may not be ready */ }
  } else if (media.kind === 'vimeo') {
    if (!vimeoReady || !vimeoPlayer || vimeoId !== media.videoId) return;
    vimeoPlayer.getCurrentTime().then(position => {
      if (Math.abs(position - target) > (force ? .6 : 1.1)) { suppressControls(1000); vimeoPlayer.setCurrentTime(target).catch(() => {}); }
    }).catch(() => {});
    vimeoPlayer.getPaused().then(paused => {
      if (media.playing && paused) { suppressControls(950); vimeoPlayer.play().then(() => $('videoUnlock').classList.add('hidden')).catch(showUnlock); }
      if (!media.playing && !paused) { suppressControls(950); vimeoPlayer.pause().catch(() => {}); }
    }).catch(() => {});
  } else {
    if (directPlayer.readyState < 1) return;
    if (Math.abs(directPlayer.currentTime - target) > (force ? .45 : .85)) {
      try { suppressControls(850); directPlayer.currentTime = target; } catch (_) {}
    }
    if (media.playing && directPlayer.paused) { suppressControls(850); directPlayer.play().then(() => $('videoUnlock').classList.add('hidden')).catch(showUnlock); }
    if (media.playing && !directPlayer.paused && !directPlayer.seeking) {
      const drift = target - directPlayer.currentTime;
      directPlayer.playbackRate = Math.abs(drift) < .12 ? 1 : (drift > 0 ? 1.06 : .94);
    } else directPlayer.playbackRate = 1;
    if (!media.playing && !directPlayer.paused) { suppressControls(850); directPlayer.pause(); }
  }
}
function sendControl(action, position) {
  if (!joined || !currentMedia || !['youtube', 'vimeo', 'direct'].includes(currentMedia.kind)) return;
  const time = Math.max(0, Number(position) || 0);
  socket.emit('media:control', { action, position: time, revision: currentMedia.revision });
  currentMedia = { ...currentMedia, position: time, updatedAt: Date.now() + clockOffset, playing: action === 'play' ? true : action === 'pause' ? false : currentMedia.playing };
  lastAppliedSyncAt = Date.now();
}
function onIncomingSync(media) {
  if (!currentMedia || media.revision !== currentMedia.revision || media.kind !== currentMedia.kind) return;
  currentMedia = media;
  lastAppliedSyncAt = Date.now();
  syncPlayback(media);
}
function renderMembers(members) {
  const list = $('membersList');
  list.replaceChildren();
  for (const member of members) {
    const el = addDom(list, 'div', 'rave-person');
    const avatar = addDom(el, 'div', 'member-avatar', initials(member.name));
    avatar.classList.toggle('is-me', member.id === myId);
    addDom(el, 'span', 'rave-person-name', member.id === myId ? 'Ты' : member.name);
    addDom(el, 'span', 'rave-person-online');
  }
  safeText($('headPeopleCount'), `${members.length} онлайн`);
  safeText($('ravePeopleCount'), String(members.length));
}
function timeLabel(timestamp) { return new Date(timestamp).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }); }
function renderMessages(messages) {
  const chat = $('chatMessages');
  const wasNearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 100;
  chat.replaceChildren();
  if (!messages.length) {
    const empty = addDom(chat, 'div', 'chat-empty');
    addDom(empty, 'strong', '', 'together.');
    addDom(empty, 'p', '', 'Сообщения участников появятся здесь.');
  } else {
    for (const m of messages) appendMessage(m);
  }
  if (wasNearBottom || !messages.length) chatScroll.scrollTop = chatScroll.scrollHeight;
}
function appendMessage(message) {
  const chat = $('chatMessages');
  const empty = chat.querySelector('.chat-empty');
  if (empty) empty.remove();
  const nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 100;
  const row = addDom(chat, 'div', 'chat-message' + (message.senderId === myId ? ' mine' : ''));
  addDom(row, 'div', 'mini-avatar', initials(message.name));
  const main = addDom(row, 'div', 'msg-main');
  const line = addDom(main, 'div', 'msg-line');
  addDom(line, 'strong', '', message.senderId === myId ? 'Ты' : message.name);
  addDom(line, 'time', '', timeLabel(message.at));
  addDom(main, 'p', '', message.body);
  if (nearBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
}
function updateVideoLabels(media) {
  const labels = {
    none: ['Выберите видео для просмотра', 'Видео пока не добавлено'],
    youtube: ['YouTube', media.url],
    direct: ['Видео', media.url],
    vimeo: ['Vimeo', media.url],
    screen: ['Прямой эфир вашей комнаты', state?.shareOwner === myId ? 'Ты показываешь экран' : 'Друг показывает тебе свой экран']
  };
  const info = labels[media.kind] || labels.none;
  safeText($('nowWatching'), info[0]);
  safeText($('watchSub'), info[1]);
  const pretty = media.kind === 'youtube' ? 'Видео YouTube' : media.kind === 'vimeo' ? 'Видео Vimeo' : media.kind === 'direct' ? 'Ваш фильм' : media.kind === 'screen' ? 'Прямая трансляция' : 'Пока ничего не играет';
  safeText($('raveNowTitle'), media.kind === 'none' ? 'Выберите фильм или видео' : pretty);
  safeText($('raveNowSource'), media.kind === 'none' ? 'Добавьте видео или пригласите участников' : media.kind === 'screen' ? 'Экран участника • эфир' : 'Пауза и перемотка общие для всех');
  const now = document.querySelector('.rave-nowplaying');
  now?.classList.toggle('rave-is-playing', media.kind !== 'none');
}
async function applyMediaState(nextState) {
  state = nextState;
  const media = nextState.media;
  if (nextState.id) roomId = nextState.id;
  $('roomCode').textContent = roomId;
  $('stageViewers').textContent = String(nextState.members.length);
  const isNew = currentRevision !== media.revision;
  const previousKind = currentMedia?.kind;
  currentMedia = media;
  renderMembers(nextState.members);
  syncVoicePeers(nextState.members);
  updateVideoLabels(media);
  $('screenShare').querySelector('span').textContent = localStream ? 'Завершить эфир' : 'Показ экрана';
  if (isNew) {
    vimeoDuration = 0; vimeoDurationAt = 0;
    currentRevision = media.revision;
    stopVideoSources();
    $('videoUnlock').classList.add('hidden');
    if (media.kind !== 'screen') {
      closePeers();
      screenPlayer.srcObject = null;
      screenStream = null;
    }
    if (media.kind === 'youtube') { setActivePlayer('youtube'); await loadYoutube(media); }
    else if (media.kind === 'direct') { setActivePlayer('direct'); loadDirect(media); }
    else if (media.kind === 'vimeo') { setActivePlayer('vimeo'); await loadVimeo(media); }
    else if (media.kind === 'screen') {
      if (nextState.shareOwner === myId && localStream) {
        setActivePlayer('screen');
        screenPlayer.muted = true;
        screenPlayer.srcObject = localStream;
        screenPlayer.play().catch(() => {});
      } else {
        setActivePlayer('waiting');
        if (previousKind !== 'screen') socket.emit('rtc:viewer-ready');
      }
    } else setActivePlayer('none');
  } else if (['youtube', 'vimeo', 'direct'].includes(media.kind) && Date.now() - lastAppliedSyncAt > 1400) {
    // Member join/leave events should not restart the player or override local playback.
    currentMedia = { ...currentMedia, ...media };
  }
  if (media.kind !== 'screen' && localStream) stopLocalShare(false);
}
function applyJoinResponse(res) {
  if (!res?.ok) throw new Error(res?.error || 'Не удалось войти в комнату.');
  joined = true;
  myId = res.you;
  roomId = res.state.id;
  history.replaceState({}, '', `/?room=${encodeURIComponent(roomId)}`);
  $('joinOverlay').classList.add('hidden');
  $('joinError').textContent = '';
  $('headerInvite').disabled = false;
  $('copyLink').disabled = false;
  $('raveShare').disabled = false;
  $('ravePrivacyInvite').disabled = false;
  $('chatInput').disabled = false;
  $('chatSend').disabled = false;
  setPresence(true);
  if (microphoneStream) socket.emit('voice:status', { enabled: true });
  calibrateClock();
  renderMessages(res.state.chat);
  applyMediaState(res.state);
  localStorage.setItem('together:nickname', nickname);
}
function joinCurrentRoom() {
  if (!roomId || !nickname || !socket.connected) return;
  socket.timeout(12000).emit('room:join', { roomId, name: nickname }, (err, res) => {
    if (err) { $('joinError').textContent = 'Не удалось подключиться. Попробуй ещё раз.'; toast('Нет связи с сервером'); return; }
    try { applyJoinResponse(res); } catch (e) { $('joinError').textContent = e.message; joined = false; }
    $('joinForm').querySelector('button').disabled = false;
  });
}

socket.on('connect', () => {
  setPresence(true);
  calibrateClock();
  if (roomId && nickname && (joined || $('joinOverlay').classList.contains('hidden'))) joinCurrentRoom();
});
socket.on('disconnect', () => {
  voiceOnDisconnect();
  setPresence(false);
  if (localStream) toast('Потеряна связь. Попробуй обновить страницу перед новой трансляцией.');
});
socket.on('room:state', data => { if (joined && data.id === roomId) applyMediaState(data); });
socket.on('chat:new', message => { if (joined) appendMessage(message); });
socket.on('media:sync', media => { if (joined) onIncomingSync(media); });
socket.on('share:forced-stop', () => stopLocalShare(false));
socket.on('share:ended', () => { closePeers(); screenPlayer.srcObject = null; screenStream = null; });
socket.on('rtc:viewer-ready', ({viewerId}) => { if (localStream && viewerId) createOfferToViewer(viewerId); });
socket.on('rtc:peer-left', ({peerId}) => { closePeer(peerId); closeVoiceForMember(peerId); });
socket.on('rtc:signal', async ({from, data}) => {
  try {
    if (data.type === 'offer') {
      if (peers.get(from)?.pc.remoteDescription) closePeer(from);
      const peer = peers.get(from) || makePeer(from);
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      await flushCandidates(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('rtc:signal', { target: from, data: { type: 'answer', sdp: answer.sdp } });
    } else if (data.type === 'answer') {
      const peer = peers.get(from);
      if (!peer) return;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      await flushCandidates(peer);
    } else if (data.type === 'candidate') {
      const peer = peers.get(from) || makePeer(from);
      if (!data.candidate) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
      else peer.pending.push(data.candidate);
    }
  } catch (e) { console.warn('WebRTC:', e); hint('Ошибка связи в трансляции. Можно попробовать остановить и запустить эфир заново.'); }
});

$('joinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const value = $('nickInput').value.trim().slice(0,28);
  if (!value) return;
  nickname = value;
  const button = e.currentTarget.querySelector('button');
  button.disabled = true;
  $('joinError').textContent = '';
  try {
    if (!roomId) {
      const response = await fetch('/api/rooms', { method: 'POST' });
      if (!response.ok) throw new Error('Не удалось создать комнату.');
      roomId = (await response.json()).id;
    }
    if (!socket.connected) { socket.connect(); await new Promise((resolve, reject) => {
      if (socket.connected) return resolve();
      socket.once('connect', resolve);
      setTimeout(() => reject(new Error('Сервер недоступен.')), 10000);
    }); }
    joinCurrentRoom();
  } catch (err) { $('joinError').textContent = err.message; button.disabled = false; }
});

async function loadVideoLink() {
  if (!joined) return toast('Сначала войди в комнату.');
  const parsed = parseSource(urlInput.value);
  if (!parsed) {
    hint('Поддерживаются YouTube, Vimeo и прямые ссылки .mp4/.webm/.m3u8. Для киносайта открой фильм и используй «Показ экрана».');
    return;
  }
  $('loadVideo').disabled = true;
  socket.timeout(8000).emit('media:set', parsed, (err, answer) => {
    $('loadVideo').disabled = false;
    if (err || !answer?.ok) return hint(answer?.error || 'Не удалось загрузить видео.');
    hint('');
    toast('Видео добавлено в вашу комнату');
  });
}
$('loadVideo').addEventListener('click', loadVideoLink);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadVideoLink(); } });
function handleDirectControl(action) {
  if (ignoreControls() || currentMedia?.kind !== 'direct') return;
  sendControl(action, directPlayer.currentTime);
}
directPlayer.addEventListener('play', () => handleDirectControl('play'));
directPlayer.addEventListener('pause', () => handleDirectControl('pause'));
directPlayer.addEventListener('seeked', () => handleDirectControl('seek'));
directPlayer.addEventListener('ended', () => handleDirectControl('pause'));
$('unlockPlay').addEventListener('click', () => {
  $('videoUnlock').classList.add('hidden');
  if (currentMedia?.kind === 'youtube' && ytReady) {
    ytPlayer.playVideo();
    if (!currentMedia.playing) sendControl('play', ytPlayer.getCurrentTime());
  } else if (currentMedia?.kind === 'direct') directPlayer.play().catch(() => showUnlock());
  else if (currentMedia?.kind === 'vimeo' && vimeoReady) vimeoPlayer.play().catch(showUnlock);
  else if (currentMedia?.kind === 'screen') screenPlayer.play().catch(showUnlock);
});

$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('chatInput');
  const body = input.value.trim();
  if (body && joined) { socket.emit('chat:send', { body }); input.value = ''; input.focus(); }
});
async function copyInvite() {
  if (!roomId) return;
  try {
    await navigator.clipboard.writeText(inviteUrl());
    toast('Ссылка скопирована — отправь её другу ♡');
  } catch (_) {
    const input = document.createElement('input');
    input.value = inviteUrl();
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    toast(ok ? 'Ссылка скопирована' : `Твоя ссылка: ${inviteUrl()}`);
  }
}
$('headerInvite').addEventListener('click', copyInvite);
$('copyLink').addEventListener('click', copyInvite);
$('fullScreen').addEventListener('click', () => {
  const el = document.querySelector('.watch-column');
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => toast('Полноэкранный режим недоступен'));
});


// Only one visual timeline is shown for direct videos. Sound remains local to each participant.
let videoMuted = false;
function syncVideoSoundButton() {
  $('videoSound').innerHTML = videoMuted ? '<svg class="icon"><use href="#i-volume-off"/></svg>' : '<svg class="icon"><use href="#i-volume"/></svg>';
  $('videoSound').title = videoMuted ? 'Включить звук видео' : 'Выключить звук видео';
  $('videoSound').setAttribute('aria-label', $('videoSound').title);
  directPlayer.muted = videoMuted;
  if (currentMedia?.kind === 'screen' && state?.shareOwner !== myId) screenPlayer.muted = videoMuted;
  if (currentMedia?.kind === 'youtube' && ytReady) {
    try { videoMuted ? ytPlayer.mute() : ytPlayer.unMute(); } catch (_) {}
  }
  if (currentMedia?.kind === 'vimeo' && vimeoReady) vimeoPlayer.setMuted(videoMuted).catch(() => {});
}
$('videoSound').addEventListener('click', () => { videoMuted = !videoMuted; syncVideoSoundButton(); });
$('cleanTest').addEventListener('click', () => {
  urlInput.value = 'https://uploads.video-commander.com/sample/BigBuckBunny.mp4';
  urlInput.focus();
  hint('Это тестовый MP4 без технических надписей. Нажми «Смотреть».');
});

function makePeer(peerId) {
  const pc = new RTCPeerConnection({ iceServers });
  const peer = { pc, pending: [] };
  peers.set(peerId, peer);
  pc.onicecandidate = evt => { if (evt.candidate) socket.emit('rtc:signal', { target: peerId, data: { type: 'candidate', candidate: evt.candidate.toJSON() } }); };
  pc.ontrack = evt => {
    if (localStream || currentMedia?.kind !== 'screen') return;
    if (!screenStream) screenStream = evt.streams[0] || new MediaStream();
    if (!evt.streams[0]) screenStream.addTrack(evt.track);
    screenPlayer.muted = videoMuted;
    screenPlayer.srcObject = screenStream;
    setActivePlayer('screen');
    screenPlayer.play().catch(() => showUnlock());
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') hint('Трансляция не соединилась. В некоторых сетях необходим TURN-сервер.');
  };
  return peer;
}
async function flushCandidates(peer) {
  const candidates = peer.pending.splice(0);
  for (const candidate of candidates) await peer.pc.addIceCandidate(candidate);
}
async function createOfferToViewer(viewerId) {
  if (!localStream || !joined || viewerId === myId) return;
  try {
    if (peers.has(viewerId) && !['closed', 'failed', 'disconnected'].includes(peers.get(viewerId).pc.connectionState)) return;
    closePeer(viewerId);
    const peer = makePeer(viewerId);
    for (const track of localStream.getTracks()) peer.pc.addTrack(track, localStream);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('rtc:signal', { target: viewerId, data: { type: 'offer', sdp: offer.sdp } });
  } catch (e) { console.warn('Unable to share:', e); hint('Не удалось подключить зрителя к трансляции.'); }
}
function closePeer(peerId) {
  const peer = peers.get(peerId);
  if (peer) { peer.pc.close(); peers.delete(peerId); }
}
function closePeers() { for (const peerId of [...peers.keys()]) closePeer(peerId); }
function stopLocalShare(announce = true) {
  const hadStream = Boolean(localStream);
  if (localStream) {
    const stream = localStream;
    localStream = null;
    for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
  }
  closePeers();
  screenPlayer.srcObject = null;
  $('screenShare').querySelector('span').textContent = 'Показ экрана';
  if (announce && hadStream) socket.emit('share:stop');
}
$('screenShare').addEventListener('click', async () => {
  if (!joined) return toast('Сначала войди в комнату.');
  if (localStream) { stopLocalShare(true); return; }
  if (sharingBusy) return;
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Трансляция доступна только через HTTPS в совместимом браузере.');
  sharingBusy = true;
  let stream;
  try {
    // This must be called directly from a click (user gesture).
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true, systemAudio: 'include', surfaceSwitching: 'include', selfBrowserSurface: 'exclude' });
    localStream = stream;
    stream.getVideoTracks()[0].onended = () => stopLocalShare(true);
    socket.timeout(9000).emit('share:start', (err, response) => {
      if (err || !response?.ok) { stopLocalShare(false); return toast(response?.error || 'Не удалось запустить эфир.'); }
      $('screenShare').querySelector('span').textContent = 'Завершить эфир';
      if (!stream.getAudioTracks().length) toast('Звук не передаётся. В Chrome выбери вкладку и «Поделиться аудио».');
      else toast('Трансляция началась — вас смотрят онлайн ♡');
    });
  } catch (error) {
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (error.name !== 'NotAllowedError') toast('Не удалось показать экран: ' + error.message);
  } finally { sharingBusy = false; }
});

setInterval(() => {
  if (!joined || !socket.connected || !currentMedia) return;
  if (['youtube','vimeo','direct'].includes(currentMedia.kind)) socket.emit('media:get');
}, 2000);
// Detect deliberate YouTube timeline jumps without treating ordinary playback as a seek.
setInterval(() => {
  if (!joined || currentMedia?.kind !== 'youtube' || !ytReady || ignoreControls()) { lastYouTubeSample = null; return; }
  const status = ytPlayer.getPlayerState();
  const position = ytPlayer.getCurrentTime();
  if (!Number.isFinite(position) || ![YT.PlayerState.PLAYING, YT.PlayerState.PAUSED].includes(status)) return;
  const now = Date.now();
  if (lastYouTubeSample) {
    const expectedAdvance = status === YT.PlayerState.PLAYING ? (now - lastYouTubeSample.at) / 1000 : 0;
    if (Math.abs(position - lastYouTubeSample.position - expectedAdvance) > 2.5) sendControl('seek', position);
  }
  lastYouTubeSample = { at: now, position };
}, 800);
fetch('/api/ice').then(res => res.ok ? res.json() : null).then(result => {
  if (Array.isArray(result?.iceServers) && result.iceServers.length) iceServers = result.iceServers;
}).catch(() => {});

// Simple, keyboard-accessible help dialog for film-site screen sharing.
const guideOverlay = $('guideOverlay');
let guideOpener = null;
function toggleGuide(show) {
  guideOverlay.classList.toggle('hidden', !show);
  document.body.style.overflow = show ? 'hidden' : '';
  if (show) { guideOpener = document.activeElement; $('closeGuide').focus(); }
  else guideOpener?.focus();
}
$('openGuide').addEventListener('click', () => toggleGuide(true));
$('closeGuide').addEventListener('click', () => toggleGuide(false));
$('guideDone').addEventListener('click', () => toggleGuide(false));
guideOverlay.addEventListener('click', e => { if (e.target === guideOverlay) toggleGuide(false); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !guideOverlay.classList.contains('hidden')) toggleGuide(false);
  if (e.key === 'Tab' && !guideOverlay.classList.contains('hidden')) {
    const focusables = [$('closeGuide'), $('guideDone')];
    if (e.shiftKey && document.activeElement === focusables[0]) { e.preventDefault(); focusables[1].focus(); }
    else if (!e.shiftKey && document.activeElement === focusables[1]) { e.preventDefault(); focusables[0].focus(); }
  }
});

/* Rave-like controls: clock offset, transport bar, chat drawer and live reactions. */
let clockCalibrating = false;
async function calibrateClock() {
  if (!socket.connected || clockCalibrating) return;
  clockCalibrating = true;
  const samples = [];
  for (let i = 0; i < 4; i++) {
    if (!socket.connected) break;
    const start = Date.now();
    const sample = await new Promise(resolve => {
      socket.timeout(2200).emit('sync:clock', {}, (err, reply) => {
        const end = Date.now();
        if (err || !Number.isFinite(reply?.serverNow)) return resolve(null);
        resolve({ offset: reply.serverNow - (start + end) / 2, rtt: end - start });
      });
    });
    if (sample) samples.push(sample);
  }
  if (samples.length) {
    // Prefer the least-delayed response, reducing cross-country latency bias.
    samples.sort((a,b) => a.rtt - b.rtt);
    clockOffset = samples[0].offset;
    clockCalibrated = true;
    if (joined) socket.emit('media:get');
  }
  clockCalibrating = false;
}
setInterval(() => { if (joined && socket.connected) calibrateClock(); }, 60000);
function formatPosition(t) {
  if (!Number.isFinite(t) || t < 0) return '00:00';
  const n = Math.floor(t), s = String(n % 60).padStart(2,'0'), m = String(Math.floor(n / 60) % 60).padStart(2,'0');
  return n >= 3600 ? `${Math.floor(n / 3600)}:${m}:${s}` : `${m}:${s}`;
}
let vimeoDuration = 0, vimeoDurationAt = 0;
function updateTransport() {
  const media = currentMedia;
  if (!media || !['youtube','vimeo','direct'].includes(media.kind)) {
    $('globalTimestamp').textContent = '00:00';
    $('globalDuration').textContent = '00:00';
    $('timelineSeek').value = 0;
    $('timelineSeek').disabled = true;
    $('globalPlay').disabled = true;
    return;
  }
  let duration = 0;
  if (media.kind === 'direct') duration = directPlayer.duration;
  if (media.kind === 'youtube' && ytReady) {
    try { duration = ytPlayer.getDuration(); } catch (_) {}
  }
  if (media.kind === 'vimeo' && vimeoReady && vimeoPlayer) {
    duration = vimeoDuration;
    if (Date.now() - vimeoDurationAt > 8000) {
      vimeoDurationAt = Date.now();
      vimeoPlayer.getDuration().then(n => { vimeoDuration = n; }).catch(() => {});
    }
  }
  const time = Math.max(0, calculatedTime(media));
  $('globalPlay').disabled = false;
  $('globalPlay').innerHTML = media.playing ? '<svg class="icon solid"><use href="#i-pause"/></svg>' : '<svg class="icon solid"><use href="#i-play"/></svg>';
  $('globalPlay').title = media.playing ? 'Пауза у всех' : 'Воспроизвести у всех';
  $('globalDuration').textContent = Number.isFinite(duration) && duration > 0 ? formatPosition(duration) : '--:--';
  const seekable = Number.isFinite(duration) && duration > 0;
  $('timelineSeek').disabled = !seekable;
  $('timelineSeek').max = seekable ? String(duration) : '100';
  if (!draggingTimeline) {
    $('globalTimestamp').textContent = formatPosition(time);
    if (seekable) $('timelineSeek').value = String(Math.min(duration, time));
  }
  $('timelineSeek').style.setProperty('--progress', seekable ? `${Math.min(100,100 * time / duration)}%` : '0%');
}
setInterval(updateTransport, 350);
async function positionForControl() {
  if (!currentMedia) return 0;
  try {
    if (currentMedia.kind === 'direct' && directPlayer.readyState) return directPlayer.currentTime;
    if (currentMedia.kind === 'youtube' && ytReady) return ytPlayer.getCurrentTime();
    if (currentMedia.kind === 'vimeo' && vimeoReady) return await vimeoPlayer.getCurrentTime();
  } catch (_) {}
  return calculatedTime(currentMedia);
}
$('globalPlay').addEventListener('click', async () => {
  if (!joined || !currentMedia || !['youtube','vimeo','direct'].includes(currentMedia.kind)) return;
  const pause = currentMedia.playing;
  const t = await positionForControl();
  suppressControls(1100);
  if (pause) {
    if (currentMedia.kind === 'youtube' && ytReady) ytPlayer.pauseVideo();
    if (currentMedia.kind === 'vimeo' && vimeoReady) vimeoPlayer.pause().catch(() => {});
    if (currentMedia.kind === 'direct') directPlayer.pause();
    sendControl('pause', t);
  } else {
    try {
      if (currentMedia.kind === 'youtube' && ytReady) ytPlayer.playVideo();
      if (currentMedia.kind === 'vimeo' && vimeoReady) await vimeoPlayer.play();
      if (currentMedia.kind === 'direct') await directPlayer.play();
      sendControl('play', t);
    } catch (_) { showUnlock(); }
  }
  updateTransport();
});
$('timelineSeek').addEventListener('input', e => {
  draggingTimeline = true;
  $('globalTimestamp').textContent = formatPosition(Number(e.currentTarget.value));
});
$('timelineSeek').addEventListener('change', async e => {
  const t = Number(e.currentTarget.value);
  draggingTimeline = false;
  if (!joined || !currentMedia || !Number.isFinite(t)) return;
  suppressControls(1250);
  try {
    if (currentMedia.kind === 'youtube' && ytReady) ytPlayer.seekTo(t, true);
    if (currentMedia.kind === 'vimeo' && vimeoReady) await vimeoPlayer.setCurrentTime(t);
    if (currentMedia.kind === 'direct') directPlayer.currentTime = t;
    sendControl('seek', t);
  } catch (_) { toast('Не удалось перемотать этот источник'); }
});
// Chat is permanently visible beneath the player, including on iPhone.
// Incoming messages scroll only when the viewer was already at the bottom.
$('closeChat')?.addEventListener('click', () => $('chatInput').focus());
$('chatToggle')?.addEventListener('click', () => $('chatInput').focus());
$('headerVideo').addEventListener('click', () => {
  sourceDetails.open = !sourceDetails.open;
  if (sourceDetails.open) $('videoUrl').focus();
});
$('headerHow').addEventListener('click', () => $('openGuide').click());
$('headerPeople').addEventListener('click', () => document.body.classList.toggle('participants-open'));
$('mentionButton').addEventListener('click', () => {
  const field = $('chatInput');
  if (field.disabled) return toast('Сначала войдите в комнату');
  const at = field.selectionStart ?? field.value.length;
  field.setRangeText('@', at, field.selectionEnd ?? at, 'end');
  field.focus();
});
$('emojiButton').addEventListener('click', () => {
  document.body.classList.toggle('show-chat-reactions');
});
$('chatShare').addEventListener('click', () => {
  if (!joined) return toast('Сначала войдите в комнату');
  copyInvite();
});
// The microphone button is wired to opt-in WebRTC voice chat below.
for (const btn of document.querySelectorAll('.reactions [data-reaction]')) {
  btn.addEventListener('click', () => document.body.classList.remove('show-chat-reactions'));
}
$('raveShare').addEventListener('click', copyInvite);
$('ravePrivacyInvite').addEventListener('click', copyInvite);
const sourceDetails = $('sourceDetails');
const smallDevice = window.matchMedia('(max-width: 800px)');
sourceDetails.open = false;
$('loadVideo').addEventListener('click', () => { sourceDetails.open = false; });
$('chatInput').addEventListener('focus', () => {
  // iOS sometimes scrolls the whole page rather than just the conversation.
  if (smallDevice.matches) {
    document.body.classList.add('chat-typing');
    requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
  }
});
$('chatInput').addEventListener('blur', () => document.body.classList.remove('chat-typing'));
function syncMobileViewport() {
  const h = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--rave-viewport', `${Math.round(h)}px`);
}
syncMobileViewport();
window.visualViewport?.addEventListener('resize', syncMobileViewport);
window.visualViewport?.addEventListener('scroll', syncMobileViewport);
window.addEventListener('resize', syncMobileViewport);
function renderReaction(emoji) {
  const floating = document.createElement('span');
  floating.className = 'flying-reaction';
  floating.textContent = emoji;
  floating.style.right = `${Math.round(Math.random() * 60)}px`;
  $('reactionStage').appendChild(floating);
  setTimeout(() => floating.remove(), 2700);
}
socket.on('reaction:new', data => { if (joined && ['❤️','😂','😮','🔥'].includes(data?.emoji)) renderReaction(data.emoji); });
for (const btn of document.querySelectorAll('[data-reaction]')) {
  btn.addEventListener('click', () => {
    if (joined) socket.emit('reaction:send', { emoji: btn.dataset.reaction });
  });
}
window.addEventListener('keydown', e => {
  if (e.code !== 'Space' || !joined || !$('joinOverlay').classList.contains('hidden')) return;
  if (['INPUT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName) || !guideOverlay.classList.contains('hidden')) return;
  e.preventDefault();
  $('globalPlay').click();
});
setActivePlayer('none');


/* ==== Together 5: opt-in microphone-to-microphone voice chat ==== */
let microphoneStream = null;
let microphoneBusy = false;
const voiceOutbound = new Map(); // peerId -> pc/session
const voiceInbound = new Map();  // speakerId -> pc/session/audio
const voiceEarlyCandidates = new Map();
const voiceButton = $('voiceInput');
const voiceLabel = $('micLabel');
const voiceUnlock = $('enableVoiceAudio');
function voiceSignal(target, data) { if (joined && socket.connected) socket.emit('voice:signal', { target, data }); }
function voiceSession() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,11)}`; }
function voiceButtonState() {
  const active = Boolean(microphoneStream);
  voiceButton.classList.toggle('voice-on', active);
  voiceButton.setAttribute('aria-pressed', String(active));
  voiceButton.setAttribute('aria-label', active ? 'Выключить микрофон' : 'Включить микрофон');
  voiceButton.title = active ? 'Выключить микрофон' : 'Включить микрофон и разрешить доступ';
  voiceLabel.textContent = active ? 'Микрофон вкл.' : 'Микрофон выкл.';
}
function voiceCloseOutbound(peerId) {
  const peer = voiceOutbound.get(peerId);
  if (!peer) return;
  voiceOutbound.delete(peerId);
  try { peer.pc.close(); } catch (_) {}
}
function voiceCloseInbound(peerId) {
  const peer = voiceInbound.get(peerId);
  if (!peer) return;
  voiceInbound.delete(peerId);
  try { peer.pc.close(); } catch (_) {}
  if (peer.audio) { peer.audio.pause(); peer.audio.srcObject = null; peer.audio.remove(); }
  for (const key of voiceEarlyCandidates.keys()) if (key.startsWith(`${peerId}/`)) voiceEarlyCandidates.delete(key);
  if (![...voiceInbound.values()].some(x => x.audio?.paused)) voiceUnlock.classList.add('hidden');
}
function closeVoiceForMember(peerId) {
  voiceCloseOutbound(peerId);
  voiceCloseInbound(peerId);
}
function voiceOnDisconnect() {
  for (const peerId of [...voiceOutbound.keys()]) voiceCloseOutbound(peerId);
  for (const peerId of [...voiceInbound.keys()]) voiceCloseInbound(peerId);
}
async function voiceFlush(peer) {
  const pending = peer.pending.splice(0);
  for (const candidate of pending) {
    try { await peer.pc.addIceCandidate(candidate); } catch (e) { console.warn('Voice ICE:', e); }
  }
}
function voicePeerConnection(target, lane, session, receiver = false) {
  const pc = new RTCPeerConnection({ iceServers });
  const peer = { pc, session, pending: [], audio: null };
  pc.onicecandidate = evt => {
    if (evt.candidate) voiceSignal(target, { type: 'candidate', lane, session, candidate: evt.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') toast('Голосовая связь не установилась. Может потребоваться TURN-сервер.');
  };
  if (receiver) {
    pc.ontrack = evt => {
      let audio = peer.audio;
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.dataset.voiceFrom = target;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        peer.audio = audio;
      }
      audio.srcObject = evt.streams?.[0] || new MediaStream([evt.track]);
      audio.play().then(() => { voiceUnlock.classList.add('hidden'); }).catch(() => {
        voiceUnlock.classList.remove('hidden');
        toast('Нажми «🔊 Звук» для включения голоса собеседника.');
      });
    };
  }
  return peer;
}
async function voiceOfferTo(peerId) {
  if (!microphoneStream || !joined || peerId === myId || !socket.connected || voiceOutbound.has(peerId)) return;
  if (!(state?.members || []).some(m => m.id === peerId)) return;
  const session = voiceSession();
  const peer = voicePeerConnection(peerId, 'sender', session);
  voiceOutbound.set(peerId, peer);
  try {
    for (const track of microphoneStream.getAudioTracks()) peer.pc.addTrack(track, microphoneStream);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    if (voiceOutbound.get(peerId) !== peer) return;
    voiceSignal(peerId, { type: 'offer', lane: 'sender', session, sdp: offer.sdp });
  } catch (e) { voiceCloseOutbound(peerId); console.warn('Voice offer:', e); toast('Не удалось начать передачу голоса'); }
}
function syncVoicePeers(members) {
  if (!microphoneStream || !joined) return;
  const active = new Set(members.map(m => m.id));
  for (const id of voiceOutbound.keys()) if (!active.has(id)) voiceCloseOutbound(id);
  for (const member of members) {
    if (member.id !== myId && !voiceOutbound.has(member.id)) voiceOfferTo(member.id);
  }
}
function stopMicrophone(announce = true) {
  const wasOn = Boolean(microphoneStream);
  const stream = microphoneStream;
  microphoneStream = null;
  if (stream) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
  for (const id of [...voiceOutbound.keys()]) voiceCloseOutbound(id);
  if (announce && wasOn && joined) socket.emit('voice:status', { enabled: false });
  voiceButtonState();
}
voiceButton.addEventListener('click', async () => {
  if (!joined) return toast('Сначала войди в комнату.');
  if (microphoneBusy) return;
  if (microphoneStream) { stopMicrophone(); toast('Микрофон выключен'); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection || !window.isSecureContext)
    return toast('Для микрофона нужен HTTPS и совместимый браузер.');
  microphoneBusy = true;
  voiceButton.disabled = true;
  try {
    // The browser asks for microphone permission from this real user click only.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
    });
    microphoneStream = stream;
    stream.getAudioTracks()[0].onended = () => stopMicrophone();
    voiceButtonState();
    socket.emit('voice:status', { enabled: true });
    for (const member of state?.members || []) if (member.id !== myId) voiceOfferTo(member.id);
    // iOS may permit remote audio autoplay once the microphone is capturing.
    for (const peer of voiceInbound.values()) peer.audio?.play().catch(() => voiceUnlock.classList.remove('hidden'));
    toast('Микрофон включён. Лучше использовать наушники.');
  } catch (error) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') toast('Доступ запрещён. Разреши микрофон в настройках сайта браузера.');
    else if (error.name === 'NotFoundError') toast('Микрофон не найден. Проверь подключение.');
    else toast('Не удалось включить микрофон: ' + (error.message || error.name));
  } finally { microphoneBusy = false; voiceButton.disabled = false; }
});
voiceUnlock.addEventListener('click', () => {
  Promise.all([...voiceInbound.values()].map(peer => peer.audio?.play().catch(() => {})))
    .then(() => { voiceUnlock.classList.add('hidden'); });
});
socket.on('voice:signal', async ({ from, data } = {}) => {
  if (!joined || !from || !data || !['offer','answer','candidate'].includes(data.type)) return;
  try {
    if (data.type === 'offer' && data.lane === 'sender') {
      if (!state?.members?.some(m => m.id === from)) return;
      voiceCloseInbound(from);
      const peer = voicePeerConnection(from, 'receiver', data.session, true);
      voiceInbound.set(from, peer);
      const earlyKey = `${from}/${data.session}`;
      peer.pending.push(...(voiceEarlyCandidates.get(earlyKey) || []));
      voiceEarlyCandidates.delete(earlyKey);
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      await voiceFlush(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      voiceSignal(from, { type: 'answer', lane: 'receiver', session: data.session, sdp: answer.sdp });
    } else if (data.type === 'answer' && data.lane === 'receiver') {
      const peer = voiceOutbound.get(from);
      if (!peer || peer.session !== data.session) return;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      await voiceFlush(peer);
    } else if (data.type === 'candidate' && data.candidate) {
      const peer = data.lane === 'sender' ? voiceInbound.get(from) : voiceOutbound.get(from);
      if (!peer || peer.session !== data.session) {
        if (data.lane === 'sender' && state?.members?.some(m => m.id === from)) {
          const key = `${from}/${data.session}`;
          const list = voiceEarlyCandidates.get(key) || [];
          if (list.length < 32) list.push(data.candidate);
          voiceEarlyCandidates.set(key, list);
        }
        return;
      }
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
      else peer.pending.push(data.candidate);
    }
  } catch (e) { console.warn('Voice signaling:', e); toast('Ошибка подключения голосового чата'); }
});
socket.on('voice:peer-muted', ({peerId} = {}) => { if (peerId) voiceCloseInbound(peerId); });
socket.on('voice:peer-left', ({peerId} = {}) => { if (peerId) closeVoiceForMember(peerId); });
window.addEventListener('pagehide', () => stopMicrophone(false));
voiceButtonState();
