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

const urlInput = $('videoUrl');
const directPlayer = $('directPlayer');
const screenPlayer = $('screenPlayer');
const chatScroll = $('chatScroll');
const youtubeWrap = $('youtubeWrap');

$('nickInput').value = nickname;
if (roomId) {
  $('joinTitle').innerHTML = 'Ваш вечер —<br><em>по приглашению.</em>';
  $('joinDescription').textContent = `Тебя пригласили в комнату ${roomId}. Введи имя, чтобы присоединиться.`;
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
    if (['https:', 'http:'].includes(u.protocol) && /\.(mp4|webm|ogg|m3u8)(?:$|[?#])/i.test(u.href)) return { kind: 'direct', url: u.href };
  } catch (_) { /* handled below */ }
  return null;
}
function calculatedTime(media) {
  return Math.max(0, Number(media.position || 0) + (media.playing ? (Date.now() - media.updatedAt) / 1000 : 0));
}
function setActivePlayer(kind) {
  $('emptyPlayer').classList.toggle('hidden', kind !== 'none');
  youtubeWrap.classList.toggle('hidden', kind !== 'youtube');
  directPlayer.classList.toggle('hidden', kind !== 'direct');
  screenPlayer.classList.toggle('hidden', kind !== 'screen');
  $('screenWaiting').classList.toggle('hidden', kind !== 'waiting');
  $('playerBadge').classList.toggle('hidden', kind === 'youtube' || kind === 'direct');
  if (kind !== 'youtube' && kind !== 'direct') $('videoUnlock').classList.add('hidden');
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
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
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
  if (!media || !['youtube', 'direct'].includes(media.kind)) return;
  suppressControls(force ? 1750 : 1100);
  const target = calculatedTime(media);
  if (media.kind === 'youtube') {
    if (!ytReady || loadedYoutubeId !== media.videoId) return;
    try {
      const current = ytPlayer.getCurrentTime();
      if (Number.isFinite(current) && Math.abs(current - target) > (force ? 1 : 2.4)) ytPlayer.seekTo(target, true);
      const status = ytPlayer.getPlayerState();
      if (media.playing && status !== YT.PlayerState.PLAYING && status !== YT.PlayerState.BUFFERING) {
        ytPlayer.playVideo();
        setTimeout(() => {
          if (currentMedia?.kind === 'youtube' && currentMedia.playing && ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING && ytPlayer.getPlayerState() !== YT.PlayerState.BUFFERING) showUnlock();
        }, 1600);
      } else if (!media.playing && (status === YT.PlayerState.PLAYING || status === YT.PlayerState.BUFFERING)) ytPlayer.pauseVideo();
    } catch (_) { /* an ad or delayed player may not be ready */ }
  } else {
    if (directPlayer.readyState < 1) return;
    if (Math.abs(directPlayer.currentTime - target) > (force ? .8 : 2.4)) {
      try { directPlayer.currentTime = target; } catch (_) {}
    }
    if (media.playing && directPlayer.paused) directPlayer.play().then(() => $('videoUnlock').classList.add('hidden')).catch(showUnlock);
    if (!media.playing && !directPlayer.paused) directPlayer.pause();
  }
}
function sendControl(action, position) {
  if (!joined || !currentMedia || !['youtube', 'direct'].includes(currentMedia.kind)) return;
  const time = Math.max(0, Number(position) || 0);
  socket.emit('media:control', { action, position: time, revision: currentMedia.revision });
  currentMedia = { ...currentMedia, position: time, updatedAt: Date.now(), playing: action === 'play' ? true : action === 'pause' ? false : currentMedia.playing };
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
    const row = addDom(list, 'div', 'member');
    addDom(row, 'div', 'member-avatar', initials(member.name));
    const info = addDom(row, 'div', 'member-info');
    addDom(info, 'strong', '', member.name + (member.id === myId ? ' (ты)' : ''));
    addDom(info, 'span', '', member.id === myId ? 'Организатор вечера ♡' : 'Смотрит с тобой');
    addDom(row, 'span', 'member-online');
  }
  safeText($('headPeopleCount'), `${members.length} онлайн`);
}
function timeLabel(timestamp) { return new Date(timestamp).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }); }
function renderMessages(messages) {
  const chat = $('chatMessages');
  const wasNearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 100;
  chat.replaceChildren();
  if (!messages.length) {
    const empty = addDom(chat, 'div', 'chat-empty');
    addDom(empty, 'div', 'chat-empty-icon', '💬');
    addDom(empty, 'strong', '', 'Тут начинается разговор');
    addDom(empty, 'p', '', 'Обсуждайте каждую сцену, не выходя из комнаты.');
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
    none: ['Выбираем, что посмотреть', 'Самый лучший фильм — тот, что вместе'],
    youtube: ['Смотрим YouTube вместе', media.url],
    direct: ['Смотрим видео вместе', media.url],
    screen: ['Прямой эфир вашей комнаты', state?.shareOwner === myId ? 'Ты показываешь экран' : 'Друг показывает тебе свой экран']
  };
  const info = labels[media.kind] || labels.none;
  safeText($('nowWatching'), info[0]);
  safeText($('watchSub'), info[1]);
}
async function applyMediaState(nextState) {
  state = nextState;
  const media = nextState.media;
  if (nextState.id) roomId = nextState.id;
  $('roomCode').textContent = roomId;
  const isNew = currentRevision !== media.revision;
  const previousKind = currentMedia?.kind;
  currentMedia = media;
  renderMembers(nextState.members);
  updateVideoLabels(media);
  $('screenShare').querySelector('span').textContent = localStream ? 'Завершить эфир' : 'Трансляция';
  if (isNew) {
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
  } else if (['youtube', 'direct'].includes(media.kind) && Date.now() - lastAppliedSyncAt > 1400) {
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
  $('chatInput').disabled = false;
  $('chatSend').disabled = false;
  setPresence(true);
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
  if (roomId && nickname && (joined || $('joinOverlay').classList.contains('hidden'))) joinCurrentRoom();
});
socket.on('disconnect', () => {
  setPresence(false);
  if (localStream) toast('Потеряна связь. Попробуй обновить страницу перед новой трансляцией.');
});
socket.on('room:state', data => { if (joined && data.id === roomId) applyMediaState(data); });
socket.on('chat:new', message => { if (joined) appendMessage(message); });
socket.on('media:sync', media => { if (joined) onIncomingSync(media); });
socket.on('share:forced-stop', () => stopLocalShare(false));
socket.on('share:ended', () => { closePeers(); screenPlayer.srcObject = null; screenStream = null; });
socket.on('rtc:viewer-ready', ({viewerId}) => { if (localStream && viewerId) createOfferToViewer(viewerId); });
socket.on('rtc:peer-left', ({peerId}) => closePeer(peerId));
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
    hint('Для YouTube подойдёт обычная ссылка. Для другого сайта нужен прямой MP4/WebM/HLS или кнопка «Трансляция» (показ вкладки).');
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
  const el = $('cinemaFrame');
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => toast('Полноэкранный режим недоступен'));
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
    screenPlayer.muted = false;
    screenPlayer.srcObject = screenStream;
    setActivePlayer('screen');
    screenPlayer.play().catch(() => toast('Нажми ▶ в плеере, чтобы запустить трансляцию.'));
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
  $('screenShare').querySelector('span').textContent = 'Трансляция';
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
  if (['youtube','direct'].includes(currentMedia.kind)) socket.emit('media:get');
}, 10000);
// Detect deliberate YouTube timeline jumps without treating ordinary playback as a seek.
setInterval(() => {
  if (!joined || currentMedia?.kind !== 'youtube' || !ytReady || ignoreControls()) { lastYouTubeSample = null; return; }
  const status = ytPlayer.getPlayerState();
  const position = ytPlayer.getCurrentTime();
  if (!Number.isFinite(position) || ![YT.PlayerState.PLAYING, YT.PlayerState.PAUSED].includes(status)) return;
  const now = Date.now();
  if (lastYouTubeSample) {
    const expectedAdvance = status === YT.PlayerState.PLAYING ? (now - lastYouTubeSample.at) / 1000 : 0;
    if (Math.abs(position - lastYouTubeSample.position - expectedAdvance) > 3.8) sendControl('seek', position);
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
