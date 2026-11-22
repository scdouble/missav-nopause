// ==UserScript==
// @name         MissAV 自動一時停止ストッパー (nopause)
// @namespace    https://github.com/aki-userscripts/missav-nopause
// @version      2.1
// @description  MissAVの動画ページで、ウィンドウのフォーカスが外れたときやタブを切り替えたときに動画が勝手に一時停止するのを防ぎます。自分での一時停止（ボタン・クリック・スペースキー・メディアキー）はそのまま使えます。
// @author       aki
// @match        https://missav.ai/*
// @match        https://*.missav.ai/*
// @match        https://missav.ws/*
// @match        https://*.missav.ws/*
// @match        https://missav.com/*
// @match        https://*.missav.com/*
// @match        https://missav.live/*
// @match        https://*.missav.live/*
// @match        https://missav.tv/*
// @match        https://*.missav.tv/*
// @match        https://missav.to/*
// @match        https://*.missav.to/*
// @match        https://missav123.com/*
// @match        https://*.missav123.com/*
// @match        https://missav01.com/*
// @match        https://*.missav01.com/*
// @match        https://123av.com/*
// @match        https://*.123av.com/*
// @match        https://123av.ws/*
// @match        https://*.123av.ws/*
// @include      /^https:\/\/([a-z0-9-]+\.)?missav[a-z0-9-]*\.[a-z]{2,}\//
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// ==/UserScript==

/*
 * 仕組み（多層防御）
 *  (a) document.hidden / visibilityState / webkitHidden / hasFocus() を「表示中・フォーカスあり」に見せかける
 *  (b) window / document / body への blur・visibilitychange 系リスナー登録と onblur 等のプロパティ代入を無視する
 *  (c) それでも届くイベントを window のキャプチャ段階で止める
 *      （window/document 宛ての blur・visibilitychange、およびページ外への focusout のみ。入力欄のフォーカス移動は止めない）
 *  (d) 保険: window.player（Plyr 等）とページ内の動画 <video> の pause() を包み、
 *      「フォーカス喪失/非表示中・直後」かつ「直前のユーザー操作がない」呼び出しだけを無視する
 * 本体のパッチはページ側 (main world) で実行する。
 */
(function () {
  'use strict';

  function missavNoPausePatch(how) {
    var TAG = '[missav-nopause]';
    var VERSION = '2.1';
    if (window.__missavNoPause) return; // 冪等: 二重適用しない

    var state = {
      version: VERSION,
      world: how || 'page(<script>注入)',
      blocked: 0,
      allowed: 0,
      droppedListeners: [],
      lastGesture: -1e9,   // 最後の isTrusted なユーザー操作（タブ切替ショートカットを除く）
      lastLoss: -1e9,      // 最後にフォーカス喪失 / 非表示化を観測した時刻
      unloading: false,
      log: []
    };
    try {
      Object.defineProperty(window, '__missavNoPause', {
        value: state, configurable: false, enumerable: false, writable: false
      });
    } catch (e) { window.__missavNoPause = state; }

    // 隔離環境側のローダーへ「ページ側で適用済み」を知らせる（DOMイベントは world をまたいで届く）
    try { document.dispatchEvent(new CustomEvent('missav-nopause:ready')); } catch (e) {}

    // DevTools で確認しやすいよう <html data-missav-nopause="2.1"> を付ける
    var markHtml = function () {
      try {
        var h = document.documentElement;
        if (!h || h.nodeName !== 'HTML') return false;
        h.setAttribute('data-missav-nopause', VERSION);
        return true;
      } catch (e) { return false; }
    };
    if (!markHtml()) {
      try {
        var mo = new MutationObserver(function () { if (markHtml()) mo.disconnect(); });
        mo.observe(document, { childList: true });
      } catch (e) {}
    }

    var now = function () { return performance.now(); };
    var note = function (msg) {
      state.log.push(Math.round(now()) + 'ms ' + msg);
      if (state.log.length > 100) state.log.shift();
    };
    var recordDropped = function (entry) {
      state.droppedListeners.push(entry);
      if (state.droppedListeners.length > 100) state.droppedListeners.shift();
    };

    var BLOCKED_TYPES = {
      blur: 1,
      visibilitychange: 1,
      webkitvisibilitychange: 1,
      mozvisibilitychange: 1,
      msvisibilitychange: 1,
      freeze: 1
    };
    var isWinOrDoc = function (t) { return t === window || t === document; };

    // ---- 本物の状態を読むために元の getter / メソッドを保存 ----
    var DocProto = Document.prototype;
    var gd = function (o, k) {
      try {
        var d = Object.getOwnPropertyDescriptor(o, k);
        return d && d.get;
      } catch (e) { return null; }
    };
    var realHiddenGet = gd(DocProto, 'hidden') || gd(document, 'hidden');
    var realVisGet = gd(DocProto, 'visibilityState') || gd(document, 'visibilityState');
    var realHasFocus = DocProto.hasFocus || document.hasFocus;
    var realHidden = function () {
      try {
        if (realHiddenGet) return !!realHiddenGet.call(document);
        if (realVisGet) return realVisGet.call(document) !== 'visible';
      } catch (e) {}
      return false;
    };
    var realFocused = function () {
      try { return realHasFocus ? !!realHasFocus.call(document) : true; } catch (e) { return true; }
    };

    // ---- (a) 表示中・フォーカスありに見せかける ----
    var spoof = function (k, v) {
      try {
        Object.defineProperty(DocProto, k, {
          configurable: true, enumerable: true, get: function () { return v; }
        });
      } catch (e) {}
    };
    spoof('hidden', false);
    spoof('webkitHidden', false);
    spoof('mozHidden', false);
    spoof('msHidden', false);
    spoof('visibilityState', 'visible');
    spoof('webkitVisibilityState', 'visible');
    try {
      Object.defineProperty(DocProto, 'hasFocus', {
        configurable: true, writable: true, value: function hasFocus() { return true; }
      });
    } catch (e) {}

    // ---- (b) リスナー登録とハンドラプロパティを無視 ----
    var ETP = EventTarget.prototype;
    var origAdd = ETP.addEventListener;
    var hookedAdd = function addEventListener(type, listener, options) {
      // strict mode で window なしの addEventListener(...) が呼ばれた場合 this === undefined になる対策
      var target = (this == null) ? window : this;
      try {
        if (isWinOrDoc(target) && typeof type === 'string' && BLOCKED_TYPES[type.toLowerCase()]) {
          recordDropped((target === window ? 'window' : 'document') + ':' + type);
          note('dropped listener ' + type);
          return undefined;
        }
      } catch (e) {}
      return origAdd.apply(target, arguments);
    };
    try {
      Object.defineProperty(ETP, 'addEventListener', {
        configurable: true, writable: true, value: hookedAdd
      });
    } catch (e) { ETP.addEventListener = hookedAdd; }

    var neuterProp = function (obj, prop) {
      if (!obj) return;
      try {
        // 既に登録されていたネイティブハンドラがあれば先に解除する
        if (obj === window || obj === document) {
          try { obj[prop] = null; } catch (e) {}
        }
        var stored = null;
        Object.defineProperty(obj, prop, {
          configurable: true, enumerable: true,
          get: function () { return stored; },
          set: function (v) { stored = v; note('ignored ' + prop + ' assignment'); }
        });
      } catch (e) {}
    };
    ['onblur', 'onvisibilitychange', 'onwebkitvisibilitychange', 'onfreeze'].forEach(function (p) {
      neuterProp(window, p);
      neuterProp(DocProto, p);
    });
    // document.body.onblur 経由で window.onblur が設定される経路も塞ぐ
    if (typeof HTMLBodyElement !== 'undefined' && HTMLBodyElement.prototype) {
      neuterProp(HTMLBodyElement.prototype, 'onblur');
    }

    // ---- (c) キャプチャ段階で止める（ここで本物の状態変化も記録） ----
    var guard = function (e) {
      if (!isWinOrDoc(e.target)) return; // 入力欄などの blur は通す
      var type = (e.type || '').toLowerCase();
      // visibilitychange は「表示に戻った時」にも発火するため、実際に非表示のときだけ lastLoss を更新する
      if (type.indexOf('visibilitychange') !== -1) {
        if (realHidden()) state.lastLoss = now();
      } else {
        state.lastLoss = now();
      }
      note('stopped ' + e.type + ' (trusted=' + e.isTrusted + ', hidden=' + realHidden() + ')');
      e.stopImmediatePropagation();
    };
    Object.keys(BLOCKED_TYPES).forEach(function (t) {
      origAdd.call(window, t, guard, true);
      origAdd.call(document, t, guard, true);
    });

    // ページ外へフォーカスが抜ける focusout（relatedTarget === null）も捕捉・遮断する
    var guardFocusOut = function (e) {
      if (e.relatedTarget !== null) return; // ページ内の別要素への移動は通す
      state.lastLoss = now();
      note('stopped focusout (left window, trusted=' + e.isTrusted + ')');
      e.stopImmediatePropagation();
    };
    origAdd.call(window, 'focusout', guardFocusOut, true);

    // ---- ユーザー操作の記録（本物の入力のみ。タブ/アプリ切替ショートカットは除外） ----
    var IGNORED_KEYS = {
      Meta: 1, Alt: 1, Control: 1, Shift: 1, Tab: 1,
      CapsLock: 1, OS: 1, ContextMenu: 1
    };
    var pointerGesture = function (e) {
      if (e.isTrusted) state.lastGesture = now();
    };
    var keyGesture = function (e) {
      if (!e.isTrusted) return;
      // Cmd+Tab / Alt+Tab / Ctrl+Tab / Cmd+1 等はタブ・ウィンドウ切替なので一時停止操作とみなさない
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (IGNORED_KEYS[e.key]) return;
      state.lastGesture = now();
    };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'touchstart', 'touchend'].forEach(function (t) {
      origAdd.call(window, t, pointerGesture, { capture: true, passive: true });
    });
    ['keydown', 'keyup'].forEach(function (t) {
      origAdd.call(window, t, keyGesture, { capture: true, passive: true });
    });

    // MediaSession（メディアキー / AirPods / コントロールセンター）からの一時停止はユーザー操作として許可
    try {
      if (navigator.mediaSession && typeof navigator.mediaSession.setActionHandler === 'function') {
        var origSetAction = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
        navigator.mediaSession.setActionHandler = function (action, handler) {
          if (action === 'pause' && typeof handler === 'function') {
            var wrappedHandler = function () {
              state.lastGesture = now();
              note('mediaSession pause gesture');
              return handler.apply(this, arguments);
            };
            return origSetAction(action, wrappedHandler);
          }
          return origSetAction(action, handler);
        };
      }
    } catch (e) {}

    origAdd.call(window, 'beforeunload', function () { state.unloading = true; }, true);
    origAdd.call(window, 'pagehide', function () { state.unloading = true; }, true);
    origAdd.call(window, 'pageshow', function () { state.unloading = false; }, true);

    // ---- (d) 保険: pause の門番 ----
    var GESTURE_MS = 1500, LOSS_GRACE_MS = 2000;
    var allowingNestedPause = 0;

    var shouldBlock = function (media) {
      var t = now();
      if (state.unloading) return false;
      if (media && media.ended) return false;
      // ユーザーが最後のフォーカス喪失より後に操作した → 本人の一時停止
      if (t - state.lastGesture < GESTURE_MS && state.lastGesture >= state.lastLoss) return false;
      var lost = realHidden() || !realFocused() || (t - state.lastLoss < LOSS_GRACE_MS);
      return lost;
    };
    var decide = function (where, media) {
      if (shouldBlock(media)) {
        state.blocked++;
        note('BLOCKED pause via ' + where);
        try { console.debug(TAG, 'blocked auto-pause via', where); } catch (e) {}
        return true;
      }
      state.allowed++;
      note('allowed pause via ' + where);
      return false;
    };

    var MediaProto = HTMLMediaElement.prototype;
    var origPause = MediaProto.pause;
    var isTargetMedia = function (m) {
      try {
        if (!m) return false;
        if (window.player && window.player.media === m) return true;
        if (m.classList && (m.classList.contains('player') || m.classList.contains('vjs-tech') || m.classList.contains('dplayer-video') || m.classList.contains('art-video'))) return true;
        if (m.closest && m.closest('.plyr, .video-js, .dplayer, .artplayer-app')) return true;
        // 上記クラスが無いプレイヤー（独自/更新後プレイヤー等）でも <video> 全般を対象にする
        // ただし明らかな短いミュート付きループプレビュー（サムネイル等）は除外
        var isVideo = (typeof HTMLVideoElement !== 'undefined' && m instanceof HTMLVideoElement) || m.tagName === 'VIDEO';
        if (isVideo) {
          if (m.muted && m.loop && isFinite(m.duration) && m.duration > 0 && m.duration < 25) return false;
          return true;
        }
      } catch (e) {}
      return false;
    };
    try {
      Object.defineProperty(MediaProto, 'pause', {
        configurable: true, writable: true,
        value: function pause() {
          if (allowingNestedPause > 0) return origPause.apply(this, arguments);
          if (isTargetMedia(this) && decide('HTMLMediaElement.pause', this)) return undefined;
          return origPause.apply(this, arguments);
        }
      });
    } catch (e) {}

    // Plyr インスタンス（window.player）の pause を包む。後からの代入・再代入にも対応
    var WRAPPED = typeof Symbol === 'function' ? Symbol('missavNoPause') : '__missavNoPauseWrapped';
    var wrapPlayer = function (p) {
      try {
        if (!p || (typeof p !== 'object' && typeof p !== 'function') || p[WRAPPED]) return p;
        var inner = p.pause;
        if (typeof inner !== 'function') return p;
        Object.defineProperty(p, 'pause', {
          configurable: true, writable: true, enumerable: false,
          value: function () {
            if (decide('player.pause', p.media)) return Promise.resolve();
            allowingNestedPause++;
            try {
              return inner.apply(this, arguments);
            } finally {
              allowingNestedPause--;
            }
          }
        });
        Object.defineProperty(p, WRAPPED, { value: true });
        note('wrapped window.player');
      } catch (e) {}
      return p;
    };
    try {
      var desc = Object.getOwnPropertyDescriptor(window, 'player');
      if (!desc || desc.configurable) {
        var existing = window.player;
        var playerValue = wrapPlayer(existing);
        Object.defineProperty(window, 'player', {
          configurable: true, enumerable: true,
          get: function () { return playerValue; },
          set: function (v) { playerValue = wrapPlayer(v); }
        });
      }
    } catch (e) { note('could not hook window.player: ' + e); }

    try {
      if (how) console.log(TAG + ' active (v' + VERSION + ', ' + how + ')', location.href);
      else console.log(TAG + ' active in page world (v' + VERSION + ')', location.href);
    } catch (e) {}
  }

  // ---------- ローダー: 必ずページ側 (main world) で実行する ----------
  var CODE = '(' + missavNoPausePatch.toString() + ')();\n//# sourceURL=missav-nopause.page.js';
  var appliedFlag = false;
  var onReady = function () { appliedFlag = true; };
  try { document.addEventListener('missav-nopause:ready', onReady, true); } catch (e) {}

  var applied = function () {
    if (appliedFlag) return true;
    try {
      var h = document.documentElement;
      return !!(h && h.nodeName === 'HTML' && h.hasAttribute('data-missav-nopause'));
    } catch (e) { return false; }
  };

  var injectScriptTag = function () {
    var parent = document.head || document.documentElement;
    if (!parent) return false;
    try {
      var s = document.createElement('script');
      s.textContent = CODE;
      parent.appendChild(s);
      s.remove();
      return applied();
    } catch (e) { return false; }
  };

  // 1) <script> 要素注入（document.head / document.documentElement がある場合のみ安全に実行）
  if (!applied() && (document.head || document.documentElement)) {
    injectScriptTag();
  }

  // 2) document-start でまだ <html> が未生成だった場合:
  //    まず現在コンテキストに直接適用（@grant none なら既にページ側）しつつ、
  //    <html> 生成直後にも念のためページ側へ <script> 注入を試みる（二重適用は冪等ガードで防ぐ）
  if (!applied() && !(document.head || document.documentElement)) {
    try { missavNoPausePatch('direct-early'); } catch (e) {}
    try {
      var bootMo = new MutationObserver(function () {
        if (document.documentElement) {
          bootMo.disconnect();
          injectScriptTag();
        }
      });
      bootMo.observe(document, { childList: true });
    } catch (e) {}
  }

  // 3) CSP でインライン <script> が拒否された場合: unsafeWindow 経由、または直接実行
  if (!applied()) {
    try {
      /* global unsafeWindow */
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow !== window && typeof unsafeWindow.eval === 'function') {
        unsafeWindow.eval(CODE);
      }
    } catch (e) {}
  }
  if (!applied()) {
    try { missavNoPausePatch('direct; CSP or main-world'); } catch (e) {}
  }

  try { document.removeEventListener('missav-nopause:ready', onReady, true); } catch (e) {}
})();
