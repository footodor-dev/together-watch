'use strict';
// Contract tests for the application logic, without external packages installed.
// The Express + Socket.IO interface is simulated; browser/network E2E tests
// still need to be run on a real deployment.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const routes = new Map();
function express() {
  const app = function requestHandler() {};
  app.disable = () => {};
  app.use = () => {};
  app.get = (url, handler) => routes.set(`GET ${url}`, handler);
  app.post = (url, handler) => routes.set(`POST ${url}`, handler);
  return app;
}
express.json = () => () => {};
express.static = () => () => {};
class FakeIO {
  constructor() { this.events = []; this.listeners = {}; }
  on(name, callback) { this.listeners[name] = callback; }
  to(target) { return { emit: (event, data) => this.events.push({ target, event, data }) }; }
}
let io;
class IOClass extends FakeIO { constructor() { super(); io = this; } }
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'express') return express;
  if (name === 'socket.io') return { Server: IOClass };
  return originalLoad.call(this, name, parent, isMain);
};
let server;
try { server = require('../server.js'); }
finally { Module._load = originalLoad; }
let seq = 0;
function connect() {
  const handlers = {};
  const messages = [];
  const socket = {
    id: `peer-${++seq}`,
    on(name, handler) { handlers[name] = handler; },
    emit(event, data) { messages.push({ event, data }); },
    join() {}, leave() {},
    to(target) { return io.to(target); },
    receive(event, ...args) {
      assert.ok(handlers[event], `event handler exists: ${event}`);
      return handlers[event](...args);
    },
    messages
  };
  io.listeners.connection(socket);
  return socket;
}
function newRoom() {
  let response = null;
  routes.get('POST /api/rooms')({}, {
    status(code) { assert.equal(code, 201); return this; },
    json(value) { response = value; }
  });
  return response.id;
}
function join(socket, roomId, name) {
  let response;
  socket.receive('room:join', { roomId, name }, answer => { response = answer; });
  return response;
}

test('public routes and identifiers', () => {
  assert.ok(routes.has('GET /health'));
  assert.ok(routes.has('GET /api/ice'));
  assert.equal(server.validMedia({kind: 'youtube', videoId: 'dQw4w9WgXcQ'}).kind, 'youtube');
  assert.equal(server.validMedia({kind: 'direct', url: 'https://example.com/test.mp4?version=1'}).kind, 'direct');
  assert.equal(server.validMedia({kind: 'direct', url: 'javascript:alert(1)'}), null);
  assert.equal(server.validMedia({kind: 'direct', url: 'https://example.com/page.html'}), null);
  assert.equal(server.validMedia({kind: 'youtube', videoId: 'invalid'}), null);
  const room = newRoom();
  assert.match(room, /^[A-HJ-NP-Z2-9]{8}$/);
});

test('two users join, chat, watch, pause and seek together', () => {
  const id = newRoom();
  const alice = connect(), bob = connect();
  assert.equal(join(alice, id, 'Alice').ok, true);
  const joinB = join(bob, id, 'Bob');
  assert.equal(joinB.ok, true);
  assert.equal(joinB.state.members.length, 2);
  alice.receive('chat:send', {body: 'Привет!'});
  const chat = io.events.filter(e => e.target === id && e.event === 'chat:new');
  assert.equal(chat.at(-1).data.body, 'Привет!');
  let added;
  alice.receive('media:set', {kind: 'youtube', videoId: 'dQw4w9WgXcQ'}, answer => { added = answer; });
  assert.equal(added.ok, true);
  const revision = io.events.filter(e => e.target === id && e.event === 'room:state').at(-1).data.media.revision;
  alice.receive('media:control', {action: 'play', position: 12, revision});
  bob.receive('media:get');
  assert.equal(bob.messages.at(-1).event, 'media:sync');
  assert.equal(bob.messages.at(-1).data.playing, true);
  assert.ok(bob.messages.at(-1).data.position >= 12);
  bob.receive('media:control', {action: 'pause', position: 42, revision});
  alice.receive('media:get');
  assert.equal(alice.messages.at(-1).data.playing, false);
  assert.equal(alice.messages.at(-1).data.position, 42);
  alice.receive('media:control', {action: 'seek', position: 56, revision});
  bob.receive('media:get');
  assert.equal(bob.messages.at(-1).data.position, 56);
  bob.receive('media:control', {action: 'pause', position: 500, revision: -1});
  bob.receive('media:get');
  assert.equal(bob.messages.at(-1).data.position, 56);
});

test('screen share is limited to members of that room', () => {
  const id1 = newRoom(), id2 = newRoom();
  const owner = connect(), viewer = connect(), stranger = connect();
  join(owner, id1, 'Owner'); join(viewer, id1, 'Viewer'); join(stranger, id2, 'Stranger');
  let response;
  owner.receive('share:start', res => { response = res; });
  assert.equal(response.ok, true);
  const count = io.events.length;
  stranger.receive('rtc:signal', {target: owner.id, data: {type: 'offer', sdp: 'fake'}});
  assert.equal(io.events.length, count);
  viewer.receive('rtc:viewer-ready');
  assert.equal(io.events.at(-1).event, 'rtc:viewer-ready');
  assert.equal(io.events.at(-1).target, owner.id);
  owner.receive('rtc:signal', {target: viewer.id, data: {type: 'offer', sdp: 'fake'}});
  assert.equal(io.events.at(-1).target, viewer.id);
  owner.receive('share:stop');
  const state = io.events.filter(e => e.event === 'room:state' && e.target === id1).at(-1).data;
  assert.equal(state.shareOwner, null);
  assert.equal(state.media.kind, 'none');
});

test('the room rejects ninth participant', () => {
  const id = newRoom();
  for (let i = 0; i < 8; i++) assert.equal(join(connect(), id, `Guest${i}`).ok, true);
  const ninth = connect();
  assert.equal(join(ninth, id, 'Guest9').ok, false);
});
