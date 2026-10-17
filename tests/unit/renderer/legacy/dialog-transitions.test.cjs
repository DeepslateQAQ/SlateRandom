'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Small event/DOM model: exercise the real modules, including capture ordering,
// animation settlement and focus restoration, without a browser dependency.
function harness({ reduced = false } = {}) {
  const animations = [], frames = new Map();
  let nextFrame = 0;
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback, capture = false) {
      const handlers = this.listeners.get(type) || [];
      handlers.push({ callback, capture: capture === true }); this.listeners.set(type, handlers);
    }
    removeEventListener(type, callback) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.callback !== callback));
    }
    dispatch(type, values = {}) {
      const event = { type, target: this, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; this.immediate = true; }, ...values };
      const chain = [];
      for (let node = event.target; node; node = node.parent) chain.push(node);
      for (const node of [...chain].reverse()) {
        for (const handler of node.listeners.get(type) || []) {
          if (handler.capture) handler.callback(event);
          if (event.immediate) return event;
        }
        if (event.stopped) return event;
      }
      for (const node of chain) {
        for (const handler of node.listeners.get(type) || []) {
          if (!handler.capture) handler.callback(event);
          if (event.immediate) return event;
        }
        if (event.stopped) return event;
      }
      return event;
    }
  }
  const document = new Events();
  document.activeElement = null;
  class Element extends Events {
    constructor(tag = 'div', id = '') {
      super(); this.tag = tag; this.id = id; this.children = []; this.dataset = {}; this.hidden = false;
      this.disabled = false; this.isConnected = true; this.attributes = new Map(); this.classes = new Set();
      this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
        toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
      const properties = new Map();
      this.style = { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name),
        getPropertyValue: name => properties.get(name) || '', getPropertyPriority: () => '' };
      this.offsetWidth = this.clientWidth = 400; this.offsetHeight = this.clientHeight = 300;
      this.clientLeft = this.clientTop = this.scrollLeft = this.scrollTop = 0;
    }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    remove() { if (this.parent?.children) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; this.isConnected = false; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector) {
      return selector === ':modal' ? Boolean(this.open) : selector === 'dialog' ? this.tag === 'dialog' :
        selector === 'dialog[open]' ? this.tag === 'dialog' && this.open : selector === 'button' ? this.tag === 'button' :
        selector === '[data-student]' ? Boolean(this.dataset.student) : selector === '[data-friend-config-status]' ? Boolean(this.status) :
        selector.startsWith('#') && this.id === selector.slice(1);
    }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest?.(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
    getBoundingClientRect() { return { left: 10, right: 410, top: 10, bottom: 310, width: 400, height: 300 }; }
    focus() { document.activeElement = this; this.dispatch('focusin'); }
    set innerHTML(_value) {
      for (const id of ['seatSettingsBtn', 'seatFriendBtn', 'saveFriendTargetsBtn', 'cancelFriendTargetsBtn']) this.appendChild(new Element('button', id));
      const status = this.appendChild(new Element('span')); status.status = true;
    }
  }
  class Dialog extends Element {
    constructor(id) { super('dialog', id); this.open = false; this.closeCount = 0; }
    showModal() { this.previousFocus = document.activeElement; this.open = true; this.focus(); }
    close(value) { this.open = false; this.returnValue = value; this.closeCount++; this.previousFocus?.focus(); this.dispatch('close'); }
    animate() {
      let finish, reject;
      const animation = { finished: new Promise((resolve, fail) => { finish = resolve; reject = fail; }),
        finish: () => finish(), cancel: () => reject(new Error('cancelled')) };
      animations.push(animation); return animation;
    }
  }
  document.children = [];
  document.appendChild = Element.prototype.appendChild;
  document.querySelectorAll = Element.prototype.querySelectorAll;
  document.getElementById = id => document.querySelectorAll('#' + id)[0] || null;
  document.head = new Element('head');
  document.documentElement = new Element('html');
  document.createElement = tag => {
    const element = new Element(tag);
    if (tag === 'style') element.sheet = { cssRules: [{ style: { setProperty() {} } }] };
    return element;
  };
  const window = new Events(); window.matchMedia = () => ({ matches: reduced, addEventListener() {} });
  const context = vm.createContext({ window, document, HTMLDialogElement: Dialog, Node: { ELEMENT_NODE: 1 },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ transform: 'none', opacity: '1' }), performance: { now: () => 0 },
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id) });
  const load = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../../src/renderer/legacy', name + '.js'), 'utf8'), context);
  load('dialog-transitions');
  return { document, window, Element, Dialog, animations, load, api: window.DialogTransitions,
    dialog(id) { return document.appendChild(new Dialog(id)); },
    key(key, values = {}, target = document.activeElement || document) { return target.dispatch('keydown', { key, ...values }); },
    release(target = document.activeElement || document) { return target.dispatch('keyup', { key: 'Escape' }); },
    async finish() { animations.at(-1).finish(); await Promise.resolve(); await Promise.resolve(); } };
}

test('close-start fires once per real exit, preserves registration and native cleanup restores focus', async () => {
  const h = harness(), trigger = h.document.appendChild(new h.Element('button'));
  trigger.focus();
  const dialog = h.dialog('import'); let starts = 0, closeEvents = 0;
  h.api.register(dialog, { onCloseStart() { starts++; assert.equal(dialog.dataset.motion, 'exit'); assert.equal(dialog.open, true); } });
  h.api.register(dialog); dialog.addEventListener('close', () => closeEvents++);
  assert.equal(await h.api.close(dialog), false); assert.equal(starts, 0);
  const opening = h.api.open(dialog); await h.finish(); await opening;
  const closing = h.api.close(dialog, 'done');
  assert.equal(h.api.close(dialog), closing); assert.equal(starts, 1); assert.equal(dialog.open, true);
  await h.finish(); await closing;
  assert.equal(dialog.open, false); assert.equal(closeEvents, 1); assert.equal(dialog.returnValue, 'done');
  assert.equal(h.document.activeElement, trigger);
  const reopening = h.api.open(dialog); await h.finish(); await reopening;
  h.api.register(dialog, { onCloseStart: null });
  const finalClose = h.api.close(dialog); await h.finish(); await finalClose; assert.equal(starts, 1);
});

test('Escape hooks consume before saving lock, held/repeat never close parent and exit ignores actions', async () => {
  const h = harness(), parent = h.dialog('config'), nested = h.dialog('provider');
  let escapes = 0, canCloseCalls = 0, context = true, unlocked = false;
  h.api.register(parent, { onEscape() { escapes++; if (context) { context = false; return true; } return false; },
    canClose() { canCloseCalls++; return unlocked; } });
  parent.showModal(); h.api.register(parent);
  const first = h.key('Escape'); assert.equal(first.defaultPrevented, true); assert.equal(first.stopped, true);
  assert.equal(escapes, 1); assert.equal(canCloseCalls, 0); assert.equal(parent.open, true);
  h.key('Escape', { repeat: true }); h.key('Escape'); assert.equal(escapes, 1);
  assert.equal(h.release().defaultPrevented, true);
  h.key('Escape'); assert.equal(escapes, 2); assert.equal(canCloseCalls, 1); assert.equal(parent.dataset.motion, undefined); h.release();
  let nestedEscapes = 0, actions = 0;
  const action = nested.appendChild(new h.Element('button'));
  action.addEventListener('click', () => actions++);
  h.api.register(nested, { onEscape: () => { nestedEscapes++; return false; } });
  nested.showModal(); assert.equal(h.api.topModal(), nested);
  h.key('Escape'); assert.equal(nested.dataset.motion, 'exit'); assert.equal(escapes, 2);
  h.release(); h.key('Escape'); assert.equal(nested.closeCount, 0); assert.equal(escapes, 2);
  assert.equal(nestedEscapes, 1);
  assert.equal(action.dispatch('click').defaultPrevented, true); assert.equal(actions, 0);
  assert.equal(nested.dispatch('submit').defaultPrevented, true);
  assert.equal(h.key('Enter', {}, action).defaultPrevented, true);
  await h.finish(); assert.equal(nested.open, false); assert.equal(parent.open, true);
  h.key('Escape', { repeat: true }); assert.equal(parent.dataset.motion, undefined); h.release();
  unlocked = true; h.api.register(parent, { onEscape: null }); h.key('Escape');
  assert.equal(escapes, 2); assert.equal(parent.dataset.motion, 'exit');
  await h.finish(); assert.equal(h.api.topModal(), null);
});

test('backdrop and native cancel preserve canClose lock without invoking Escape hook', async () => {
  const h = harness({ reduced: true }), dialog = h.dialog('provider'); let unlocked = false, escapes = 0, starts = 0;
  h.api.register(dialog, { canClose: () => unlocked, onEscape: () => { escapes++; return true; }, onCloseStart: () => starts++ });
  await h.api.open(dialog);
  assert.equal(dialog.dispatch('cancel').defaultPrevented, true); assert.equal(dialog.open, true);
  dialog.dispatch('click', { clientX: 0, clientY: 0 }); assert.equal(dialog.open, true);
  unlocked = true; dialog.dispatch('click', { clientX: 20, clientY: 20 }); assert.equal(dialog.open, true);
  dialog.dispatch('click', { clientX: 0, clientY: 0 }); assert.equal(dialog.open, false); assert.equal(starts, 1);
  await h.api.open(dialog); dialog.dispatch('cancel'); assert.equal(dialog.open, false); assert.equal(starts, 2); assert.equal(escapes, 0);
});

test('friend context dismiss discards drafts, restores seat attributes and source focus; arrows remain local', async () => {
  const h = harness({ reduced: true }), dialog = h.dialog('configDialog');
  const grid = dialog.appendChild(new h.Element('div', 'rosterSeats'));
  const first = grid.appendChild(new h.Element('button')), second = grid.appendChild(new h.Element('button'));
  first.dataset.student = '1'; second.dataset.student = '2';
  first.setAttribute('aria-expanded', 'false'); second.setAttribute('aria-pressed', 'original');
  let commits = 0;
  h.load('friend-seat-config'); const friend = h.window.FriendSeatConfig;
  friend.init({ getState: () => ({ students: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] }), commitTargets() { commits++; } });
  h.api.register(dialog, { onEscape: () => friend.dismiss() }); await h.api.open(dialog);
  assert.equal(friend.dismiss(), false); assert.equal(friend.select('1', first), true);
  const toolbar = h.document.getElementById('friendSeatToolbar'), settings = toolbar.querySelector('#seatSettingsBtn'), edit = toolbar.querySelector('#seatFriendBtn');
  assert.equal(h.document.activeElement, settings);
  assert.equal(h.key('ArrowRight').defaultPrevented, true); assert.equal(h.document.activeElement, edit);
  edit.dispatch('click'); friend.select('2', second); assert.equal(friend.isEditing(), true); assert.equal(second.getAttribute('aria-pressed'), 'true');
  h.key('Escape'); assert.equal(toolbar.hidden, true); assert.equal(friend.isEditing(), false); assert.equal(commits, 0);
  assert.equal(h.document.activeElement, first); assert.equal(first.getAttribute('aria-expanded'), 'false');
  assert.equal(second.getAttribute('aria-pressed'), 'original'); assert.equal(friend.dismiss(), false);
  h.key('Escape', { repeat: true }); assert.equal(dialog.open, true); h.release();
  h.key('Escape'); assert.equal(dialog.open, false);
});
