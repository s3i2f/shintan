/**
 * 連作投稿フォーム | 縦書き組版・LaTeX
 * 外部依存ゼロ Vanilla JavaScript
 */

(function () {
  'use strict';

  // ==========================================================================
  // 定数 & 初期データ
  // ==========================================================================
  const STORAGE_KEY = 'tanka_latex_tool_data_v3';

  // JIS X 4051 準拠のルビ記法: ｜親文字《ルビ》 または 漢字《ルビ》
  function createRubyRegex() {
    return /(?:[|｜]([^《\r\n]+)《([^》\r\n]*)》|([\p{Script=Han}々〆ヵヶ]+)《([^》\r\n]*)》)/gu;
  }

  function createInitialState() {
    return {
      title: '',
      author: '',
      songs: [
        { id: 's-1', kotobagaki: '', content: '' }
      ]
    };
  }

  // ==========================================================================
  // 状態管理 (State)
  // ==========================================================================
  let state = {
    title: '',
    author: '',
    songs: []
  };

  // ルビモーダル編集用の一時状態
  let rubyEditingState = {
    targetSongId: null,
    targetField: 'content', // 'content' | 'kotobagaki'
    originalText: '',
    currentText: '',
    selectedParent: '',
    rubyInput: '',
    // ピンポイント置換用: { type: 'tile' | 'pill' | 'quick', segIndex, startIndex, endIndex, parentText, ruby }
    activeTarget: null
  };

  // モーダルアクセシビリティ用（フォーカス復帰）
  let lastTriggerElement = null;

  // ==========================================================================
  // DOM キャッシュ
  // ==========================================================================
  const elements = {
    appLayout: document.querySelector('.app-layout'),
    clearAllBtn: document.getElementById('btn-clear-all'),
    saveStatus: document.getElementById('save-status'),
    mobileNavTabs: document.querySelectorAll('.mobile-nav-tabs .tab-btn'),

    rensakuTitleInput: document.getElementById('input-rensaku-title'),
    rensakuAuthorInput: document.getElementById('input-rensaku-author'),
    songCountBadge: document.getElementById('song-count-badge'),

    songCardList: document.getElementById('song-card-list'),
    addSongBtn: document.getElementById('btn-add-song'),

    verticalPreviewContent: document.getElementById('vertical-preview-content'),
    paperScrollContainer: document.getElementById('paper-scroll-container'),
    btnCopyLatex: document.getElementById('btn-copy-latex'),

    // ルビモーダル
    rubyModalBackdrop: document.getElementById('ruby-modal-backdrop'),
    rubyModalBtnClose: document.getElementById('ruby-modal-btn-close'),
    rubyTargetContentBtn: document.getElementById('ruby-target-content-btn'),
    rubyTargetKotobagakiBtn: document.getElementById('ruby-target-kotobagaki-btn'),
    rubyPreviewText: document.getElementById('ruby-preview-text'),
    kanjiQuickSection: document.getElementById('kanji-quick-section'),
    kanjiQuickPills: document.getElementById('kanji-quick-pills'),
    charTilesContainer: document.getElementById('char-tiles-container'),
    rubyParentInput: document.getElementById('ruby-parent-input'),
    rubyReadingInput: document.getElementById('ruby-reading-input'),
    rubyApplyBtn: document.getElementById('ruby-apply-btn'),
    rubySaveBtn: document.getElementById('ruby-save-btn'),

    // トースト & 確認モーダル
    toast: document.getElementById('toast'),
    toastMessage: document.getElementById('toast-message'),
    modalBackdrop: document.getElementById('modal-backdrop'),
    modalMessage: document.getElementById('modal-message'),
    modalBtnCancel: document.getElementById('modal-btn-cancel'),
    modalBtnConfirm: document.getElementById('modal-btn-confirm')
  };

  // ==========================================================================
  // ユーティリティ
  // ==========================================================================
  function generateId() {
    return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // LaTeX 特殊文字のエスケープ
  function escapeLatex(str) {
    if (!str) return '';
    return str
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/([%_&#${}])/g, '\\$1')
      .replace(/\^/g, '\\textasciicircum{}')
      .replace(/~/g, '\\textasciitilde{}');
  }

  function renderRubyToHtml(text) {
    if (!text) return '';
    const safeText = escapeHtml(text);
    const regex = createRubyRegex();
    return safeText.replace(regex, (_match, p1, r1, p2, r2) => {
      const parent = p1 || p2;
      const ruby = r1 || r2;
      if (!ruby) return parent;
      return `<ruby>${parent}<rt>${ruby}</rt></ruby>`;
    });
  }

  let toastTimer = null;
  function showToast(msg, duration = 1800) {
    if (toastTimer) clearTimeout(toastTimer);
    elements.toastMessage.textContent = msg;
    elements.toast.classList.add('show');
    toastTimer = setTimeout(() => {
      elements.toast.classList.remove('show');
    }, duration);
  }

  let saveTimer = null;
  function markSaving() {
    elements.saveStatus.classList.add('saving');
    elements.saveStatus.querySelector('.save-text').textContent = '保存中';
  }
  function markSaved() {
    elements.saveStatus.classList.remove('saving');
    elements.saveStatus.querySelector('.save-text').textContent = '保存済';
  }

  function saveToStorage() {
    markSaving();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        markSaved();
      } catch (e) {
        console.warn('localStorage save failed', e);
      }
    }, 250);
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.songs) && parsed.songs.length > 0) {
          state = parsed;
          return;
        }
      }
    } catch (e) {}
    state = createInitialState();
  }

  // ==========================================================================
  // Akkas タイル状ルビロジック（セグメント・インデックス管理）
  // ==========================================================================
  function parseRubySegments(content) {
    if (!content) return [];
    const segments = [];
    const regex = createRubyRegex();
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        segments.push({
          type: 'text',
          text: content.slice(lastIndex, match.index),
          startIndex: lastIndex,
        });
      }
      const parent = match[1] || match[3];
      const ruby = match[2] || match[4] || '';
      segments.push({
        type: 'ruby',
        parent,
        ruby,
        raw: match[0],
        startIndex: match.index,
      });
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < content.length) {
      segments.push({
        type: 'text',
        text: content.slice(lastIndex),
        startIndex: lastIndex,
      });
    }

    return segments;
  }

  // 漢字熟語とその位置（segIndex, startIndex, endIndex）を抽出
  function extractKanjiOccurrences(content) {
    const segments = parseRubySegments(content);
    const items = [];
    const kanjiRegex = /[\p{Script=Han}々〆ヵヶ]+/gu;

    segments.forEach((seg, segIdx) => {
      if (seg.type === 'text') {
        let m;
        while ((m = kanjiRegex.exec(seg.text)) !== null) {
          items.push({
            word: m[0],
            segIndex: segIdx,
            startIndex: m.index,
            endIndex: m.index + m[0].length - 1
          });
        }
      }
    });

    return items;
  }

  // 手動入力時用フォールバック
  function applyRubyToContent(content, parentText, rubyText) {
    if (!content || !parentText || !rubyText) return content;

    const escapedParent = escapeRegex(parentText);
    const existingPattern = new RegExp(
      `([|｜]${escapedParent}|(?<![\\p{Script=Han}々〆ヵヶ])${escapedParent})《[^》\r\n]*》`,
      'gu'
    );
    if (existingPattern.test(content)) {
      existingPattern.lastIndex = 0;
      return content.replace(existingPattern, (_match, p1) => `${p1}《${rubyText}》`);
    }

    const isPureKanji = /^[\p{Script=Han}々〆ヵヶ]+$/u.test(parentText);
    const segments = parseRubySegments(content);
    let replaced = false;
    const newParts = [];

    for (const seg of segments) {
      if (seg.type === 'ruby') {
        newParts.push(seg.raw);
      } else if (!replaced && seg.text.includes(parentText)) {
        if (isPureKanji) {
          const standalonePattern = new RegExp(
            `(?<![\\p{Script=Han}々〆ヵヶ])${escapedParent}(?![\\p{Script=Han}々〆ヵヶ])`,
            'u'
          );
          if (standalonePattern.test(seg.text)) {
            newParts.push(seg.text.replace(standalonePattern, () => `${parentText}《${rubyText}》`));
            replaced = true;
            continue;
          }
          const pipedFormat = `｜${parentText}《${rubyText}》`;
          const firstMatchPattern = new RegExp(escapedParent, 'u');
          newParts.push(seg.text.replace(firstMatchPattern, () => pipedFormat));
          replaced = true;
        } else {
          const pipedFormat = `｜${parentText}《${rubyText}》`;
          newParts.push(seg.text.replace(parentText, () => pipedFormat));
          replaced = true;
        }
      } else {
        newParts.push(seg.text);
      }
    }

    return newParts.join('');
  }

  function removeRubyFromContent(content, parentText, rubyText) {
    if (!content) return '';
    const escapedParent = escapeRegex(parentText);
    const escapedRuby = rubyText ? escapeRegex(rubyText) : '[^》\r\n]*';
    const pattern = new RegExp(
      `(?:[|｜]${escapedParent}《${escapedRuby}》|(?<![\\p{Script=Han}々〆ヵヶ])${escapedParent}《${escapedRuby}》)`,
      'gu'
    );
    return content.replace(pattern, () => parentText);
  }

  // ==========================================================================
  // LaTeX ソースコード生成（特殊文字エスケープ & 空歌除外）
  // ==========================================================================
  function formatTextForLatex(text) {
    if (!text) return '';
    const segments = parseRubySegments(text);
    return segments.map((seg) => {
      if (seg.type === 'ruby') {
        const parent = escapeLatex(seg.parent);
        const ruby = escapeLatex(seg.ruby);
        return `\\ruby[g]{${parent}}{${ruby}}`;
      }
      return escapeLatex(seg.text);
    }).join('');
  }

  function generateLatexCode() {
    const title = escapeLatex(state.title.trim()) || '無題';
    const author = escapeLatex(state.author.trim()) || '作者';

    const lines = [];
    lines.push('\\begin{rensaku}');
    lines.push(`    \\title{${title}}`);
    lines.push(`    \\author{${author}}`);
    lines.push('');

    state.songs.forEach((song) => {
      const rawContent = song.content.trim();
      const rawKotobagaki = song.kotobagaki ? song.kotobagaki.trim() : '';

      // 空の歌は除外（プレビューと同じ判定）
      if (!rawContent && !rawKotobagaki) return;

      const content = formatTextForLatex(rawContent);
      const kotobagaki = formatTextForLatex(rawKotobagaki);

      if (kotobagaki) {
        lines.push('        \\begin{tanka}');
        lines.push(`            \\kotobagaki{${kotobagaki}}`);
        lines.push(`            \\uta{${content}}`);
        lines.push('        \\end{tanka}');
        lines.push('');
      } else {
        lines.push(`        \\uta{${content}}`);
        lines.push('');
      }
    });

    lines.push('\\end{rensaku}');
    return lines.join('\n');
  }

  // ==========================================================================
  // ルビモーダル UI 制御
  // ==========================================================================
  function openRubyModal(songId, field = 'content', triggerEl = null) {
    if (triggerEl) {
      lastTriggerElement = triggerEl;
    }

    const song = state.songs.find(s => s.id === songId);
    if (!song) return;

    // 指定フィールドが空で、もう一方が空でない場合は自動調整
    if (!song[field]?.trim()) {
      const otherField = field === 'content' ? 'kotobagaki' : 'content';
      if (song[otherField]?.trim()) {
        field = otherField;
      }
    }

    const initialText = song[field] || '';
    if (!initialText.trim()) {
      showToast('テキストを入力してからルビを設定してください');
      return;
    }

    rubyEditingState = {
      targetSongId: songId,
      targetField: field,
      originalText: initialText,
      currentText: initialText,
      selectedParent: '',
      rubyInput: '',
      activeTarget: null
    };

    updateTargetSwitchUI();
    renderRubyModalContent();

    elements.rubyModalBackdrop.classList.add('open');
    if (elements.appLayout) elements.appLayout.setAttribute('aria-hidden', 'true');

    // フォーカスをルビ入力欄または閉じるボタンへ
    setTimeout(() => {
      elements.rubyReadingInput.focus();
    }, 50);
  }

  function updateTargetSwitchUI() {
    const field = rubyEditingState.targetField;
    elements.rubyTargetContentBtn.classList.toggle('active', field === 'content');
    elements.rubyTargetKotobagakiBtn.classList.toggle('active', field === 'kotobagaki');
  }

  function switchRubyModalField(newField) {
    if (rubyEditingState.targetField === newField) return;

    // 現在編集中のフィールドを保存
    const song = state.songs.find(s => s.id === rubyEditingState.targetSongId);
    if (song) {
      song[rubyEditingState.targetField] = rubyEditingState.currentText;
      saveToStorage();
      renderSongCards();
      requestPreviewUpdate();
    }

    const nextText = song ? (song[newField] || '') : '';
    rubyEditingState.targetField = newField;
    rubyEditingState.originalText = nextText;
    rubyEditingState.currentText = nextText;
    rubyEditingState.selectedParent = '';
    rubyEditingState.rubyInput = '';
    rubyEditingState.activeTarget = null;

    updateTargetSwitchUI();
    renderRubyModalContent();

    if (!nextText.trim()) {
      showToast(`${newField === 'content' ? '短歌本文' : '詞書'}が未入力です`);
    }
  }

  function closeRubyModal() {
    elements.rubyModalBackdrop.classList.remove('open');
    if (elements.appLayout) elements.appLayout.removeAttribute('aria-hidden');
    rubyEditingState.targetSongId = null;

    // トリガー元にフォーカス復帰
    if (lastTriggerElement && typeof lastTriggerElement.focus === 'function') {
      lastTriggerElement.focus();
    }
  }

  function renderRubyModalContent() {
    const { currentText, selectedParent, rubyInput, activeTarget } = rubyEditingState;

    // 1. プレビュー
    elements.rubyPreviewText.innerHTML = renderRubyToHtml(currentText) || '（空）';

    // 2. 漢字クイック選択ピル（出現位置付き）
    const kanjiItems = extractKanjiOccurrences(currentText);
    if (kanjiItems.length > 0) {
      elements.kanjiQuickSection.style.display = 'block';
      elements.kanjiQuickPills.innerHTML = '';

      kanjiItems.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isCurrentActive =
          activeTarget &&
          activeTarget.segIndex === item.segIndex &&
          activeTarget.startIndex === item.startIndex;

        btn.className = `kanji-pill ${isCurrentActive ? 'active' : ''}`;
        btn.textContent = item.word;
        btn.addEventListener('click', () => {
          rubyEditingState.activeTarget = {
            type: 'quick',
            segIndex: item.segIndex,
            startIndex: item.startIndex,
            endIndex: item.endIndex,
            parentText: item.word
          };
          rubyEditingState.selectedParent = item.word;
          rubyEditingState.rubyInput = '';
          elements.rubyParentInput.value = item.word;
          elements.rubyReadingInput.value = '';
          renderRubyModalContent();
          elements.rubyReadingInput.focus();
        });
        elements.kanjiQuickPills.appendChild(btn);
      });
    } else {
      elements.kanjiQuickSection.style.display = 'none';
    }

    // 3. 1文字タイル & ルビピル
    elements.charTilesContainer.innerHTML = '';
    const segments = parseRubySegments(currentText);

    segments.forEach((seg, segIdx) => {
      if (seg.type === 'ruby') {
        // 設定済ルビピル
        const pill = document.createElement('button');
        pill.type = 'button';
        const isEditingThisPill =
          activeTarget &&
          activeTarget.type === 'pill' &&
          activeTarget.segIndex === segIdx;

        pill.className = `ruby-tile-pill ${isEditingThisPill ? 'active' : ''}`;
        pill.title = 'クリックして読みを編集・削除（ルビを空にして適用で解除）';
        pill.innerHTML = `
          <span class="ruby-tile-top">${escapeHtml(seg.ruby)}</span>
          <span class="ruby-tile-bottom">${escapeHtml(seg.parent)}</span>
        `;
        pill.addEventListener('click', () => {
          rubyEditingState.activeTarget = {
            type: 'pill',
            segIndex: segIdx,
            parentText: seg.parent,
            ruby: seg.ruby
          };
          rubyEditingState.selectedParent = seg.parent;
          rubyEditingState.rubyInput = seg.ruby;
          elements.rubyParentInput.value = seg.parent;
          elements.rubyReadingInput.value = seg.ruby;
          renderRubyModalContent();
          elements.rubyReadingInput.focus();
        });
        elements.charTilesContainer.appendChild(pill);
        return;
      }

      // 通常文字タイル
      const chars = Array.from(seg.text);
      chars.forEach((char, charIdx) => {
        if (char === ' ' || char === '　') {
          const sp = document.createElement('span');
          sp.className = 'space-tile';
          sp.textContent = '␣';
          elements.charTilesContainer.appendChild(sp);
          return;
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'char-tile';
        btn.textContent = char;

        const isSelected =
          activeTarget &&
          (activeTarget.type === 'tile' || activeTarget.type === 'quick') &&
          activeTarget.segIndex === segIdx &&
          charIdx >= activeTarget.startIndex &&
          charIdx <= activeTarget.endIndex;

        if (isSelected) {
          btn.classList.add('selected');
        }

        btn.addEventListener('click', () => {
          handleTileClick(segIdx, charIdx, seg.text);
        });

        elements.charTilesContainer.appendChild(btn);
      });
    });

    // 4. 入力フィールド
    elements.rubyParentInput.value = selectedParent;
    elements.rubyReadingInput.value = rubyInput;
  }

  function handleTileClick(segIdx, charIdx, segText) {
    const chars = Array.from(segText);
    const target = rubyEditingState.activeTarget;

    if (!target || target.type !== 'tile' || target.segIndex !== segIdx) {
      // 1文字選択
      rubyEditingState.activeTarget = {
        type: 'tile',
        segIndex: segIdx,
        startIndex: charIdx,
        endIndex: charIdx,
        parentText: chars[charIdx]
      };
      rubyEditingState.selectedParent = chars[charIdx];
      rubyEditingState.rubyInput = '';
    } else if (target.startIndex === charIdx && target.endIndex === charIdx) {
      // 選択解除
      rubyEditingState.activeTarget = null;
      rubyEditingState.selectedParent = '';
      rubyEditingState.rubyInput = '';
    } else {
      // 範囲選択
      const start = Math.min(target.startIndex, charIdx);
      const end = Math.max(target.startIndex, charIdx);
      const parent = chars.slice(start, end + 1).join('');
      rubyEditingState.activeTarget = {
        type: 'tile',
        segIndex: segIdx,
        startIndex: start,
        endIndex: end,
        parentText: parent
      };
      rubyEditingState.selectedParent = parent;
      rubyEditingState.rubyInput = '';
    }

    renderRubyModalContent();
    elements.rubyReadingInput.focus();
  }

  // 同一単語が複数ある場合でも、インデックス位置を指定して正確に置換
  function applyRubyInModal() {
    const parent = elements.rubyParentInput.value.trim();
    const ruby = elements.rubyReadingInput.value.trim();

    if (!parent) return;

    const target = rubyEditingState.activeTarget;
    const segments = parseRubySegments(rubyEditingState.currentText);

    if (target && target.type === 'pill' && segments[target.segIndex]?.type === 'ruby') {
      // 既存ルビピルの編集または解除
      if (!ruby) {
        // 解除: プレーンテキストに戻す
        segments[target.segIndex] = {
          type: 'text',
          text: target.parentText
        };
      } else {
        // 更新: ピンポイント選択時は常に境界を明示する（青｜空《そら》のように安全に区切られる）
        const raw = `｜${parent}《${ruby}》`;
        segments[target.segIndex] = {
          type: 'ruby',
          parent,
          ruby,
          raw
        };
      }
      rubyEditingState.currentText = segments.map(s => s.type === 'ruby' ? s.raw : s.text).join('');
    } else if (target && (target.type === 'tile' || target.type === 'quick') && segments[target.segIndex]?.type === 'text') {
      // タイル選択またはクイック選択した特定位置のピンポイント置換
      const seg = segments[target.segIndex];
      const chars = Array.from(seg.text);
      const before = chars.slice(0, target.startIndex).join('');
      const after = chars.slice(target.endIndex + 1).join('');

      let replacement;
      if (!ruby) {
        replacement = parent;
      } else {
        // 熟語の一部ルビ等での誤結合を防ぐため、常に境界を明示するパイプを付与（例: 青空の「空」だけに振る場合「青｜空《そら》」）
        replacement = `｜${parent}《${ruby}》`;
      }

      segments[target.segIndex] = {
        type: 'text',
        text: before + replacement + after
      };
      rubyEditingState.currentText = segments.map(s => s.type === 'ruby' ? s.raw : s.text).join('');
    } else {
      // 手動入力フォールバック
      if (!ruby) {
        rubyEditingState.currentText = removeRubyFromContent(rubyEditingState.currentText, parent, rubyEditingState.rubyInput);
      } else {
        rubyEditingState.currentText = applyRubyToContent(rubyEditingState.currentText, parent, ruby);
      }
    }

    rubyEditingState.selectedParent = '';
    rubyEditingState.rubyInput = '';
    rubyEditingState.activeTarget = null;
    renderRubyModalContent();
  }

  function saveRubyModalResult() {
    const { targetSongId, targetField, currentText } = rubyEditingState;
    if (!targetSongId) return;

    const song = state.songs.find(s => s.id === targetSongId);
    if (song) {
      song[targetField] = currentText;
      saveToStorage();
      renderSongCards();
      requestPreviewUpdate();
    }
    closeRubyModal();
  }

  // ==========================================================================
  // レンダリング (UI更新) & スムーズプレビュー
  // ==========================================================================
  let previewRafId = null;
  let previewDebounceTimer = null;

  function requestPreviewUpdate() {
    if (previewDebounceTimer) {
      clearTimeout(previewDebounceTimer);
    }
    previewDebounceTimer = setTimeout(() => {
      if (previewRafId) {
        cancelAnimationFrame(previewRafId);
      }
      previewRafId = requestAnimationFrame(() => {
        updatePreview();
        previewRafId = null;
      });
    }, 60);
  }

  function renderSongCards() {
    elements.songCardList.innerHTML = '';
    elements.songCountBadge.textContent = `${state.songs.length}首`;

    state.songs.forEach((song, index) => {
      const card = document.createElement('div');
      card.className = 'form-card song-card';
      card.dataset.id = song.id;

      card.innerHTML = `
        <div class="card-header">
          <span class="card-song-badge">第${index + 1}首</span>
          <div class="card-actions">
            <button type="button" class="btn-action btn-action-ruby" data-action="ruby" title="文字タイルからルビを設定">ルビを振る</button>
            <button type="button" class="btn-action btn-action-delete" data-action="delete" title="この歌を削除">削除</button>
          </div>
        </div>

        <div class="card-body">
          <div class="form-row">
            <label class="form-label sub-label">詞書</label>
            <input 
              type="text" 
              class="form-input input-kotobagaki" 
              value="${escapeHtml(song.kotobagaki || '')}"
            >
          </div>

          <div class="form-row">
            <label class="form-label sub-label">短歌本文 <span class="badge-required">必須</span></label>
            <textarea 
              class="form-textarea input-song-content" 
              rows="2"
            >${escapeHtml(song.content)}</textarea>
          </div>
        </div>
      `;

      const kotobagakiInput = card.querySelector('.input-kotobagaki');
      const contentTextarea = card.querySelector('.input-song-content');
      const rubyBtn = card.querySelector('[data-action="ruby"]');
      const deleteBtn = card.querySelector('[data-action="delete"]');

      // フォーカス追跡（詞書か本文かを確実に判別）
      let lastFocusedField = 'content';
      kotobagakiInput.addEventListener('focus', () => { lastFocusedField = 'kotobagaki'; });
      contentTextarea.addEventListener('focus', () => { lastFocusedField = 'content'; });

      // 日本語IME変換中の過剰レンダリング防止
      let isComposingKotobagaki = false;
      let isComposingContent = false;

      kotobagakiInput.addEventListener('compositionstart', () => { isComposingKotobagaki = true; });
      kotobagakiInput.addEventListener('compositionend', (e) => {
        isComposingKotobagaki = false;
        song.kotobagaki = e.target.value;
        saveToStorage();
        requestPreviewUpdate();
      });
      kotobagakiInput.addEventListener('input', (e) => {
        song.kotobagaki = e.target.value;
        saveToStorage();
        if (!isComposingKotobagaki) {
          requestPreviewUpdate();
        }
      });

      contentTextarea.addEventListener('compositionstart', () => { isComposingContent = true; });
      contentTextarea.addEventListener('compositionend', (e) => {
        isComposingContent = false;
        song.content = e.target.value;
        saveToStorage();
        requestPreviewUpdate();
      });
      contentTextarea.addEventListener('input', (e) => {
        song.content = e.target.value;
        saveToStorage();
        if (!isComposingContent) {
          requestPreviewUpdate();
        }
      });

      // ルビボタン押下 -> Akkas文字タイルモーダル起動
      rubyBtn.addEventListener('click', () => {
        // 直近フォーカスまたは入力状況から最適な対象フィールドを決定
        let targetField = lastFocusedField;
        const hasContent = !!song.content.trim();
        const hasKotobagaki = !!song.kotobagaki.trim();

        if (targetField === 'kotobagaki' && !hasKotobagaki && hasContent) {
          targetField = 'content';
        } else if (targetField === 'content' && !hasContent && hasKotobagaki) {
          targetField = 'kotobagaki';
        }

        openRubyModal(song.id, targetField, rubyBtn);
      });

      // 削除（入力済みの場合は誤操作防止のため確認ダイアログを表示）
      deleteBtn.addEventListener('click', () => {
        if (state.songs.length <= 1) {
          showToast('最低1首必要です');
          return;
        }

        const hasContent = !!song.content.trim() || !!song.kotobagaki.trim();
        if (hasContent) {
          showConfirmModal(`第${index + 1}首を削除しますか？`, () => {
            deleteSong(index);
            showToast(`第${index + 1}首を削除しました`);
          }, deleteBtn);
        } else {
          deleteSong(index);
        }
      });

      elements.songCardList.appendChild(card);
    });
  }

  function deleteSong(index) {
    state.songs.splice(index, 1);
    saveToStorage();
    renderSongCards();
    requestPreviewUpdate();
  }

  function addNewSong() {
    if (elements.rensakuTitleInput) {
      state.title = elements.rensakuTitleInput.value;
    }
    if (elements.rensakuAuthorInput) {
      state.author = elements.rensakuAuthorInput.value;
    }

    const newSong = {
      id: generateId(),
      kotobagaki: '',
      content: ''
    };
    state.songs.push(newSong);
    saveToStorage();
    renderSongCards();
    requestPreviewUpdate();

    const lastCard = elements.songCardList.lastElementChild;
    if (lastCard) {
      lastCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const textarea = lastCard.querySelector('.input-song-content');
      if (textarea) textarea.focus();
    }
  }

  function updatePreview() {
    renderVerticalPreview();
  }

  function renderVerticalPreview() {
    let html = '';

    // タイトル・作者名
    html += `
      <div class="v-header-block">
        <h1 class="v-text v-title">${escapeHtml(state.title.trim()) || ''}</h1>
        <div class="v-text v-author">${escapeHtml(state.author.trim()) || ''}</div>
      </div>
    `;

    // 短歌ブロック
    state.songs.forEach((song) => {
      const content = song.content.trim();
      const kotobagaki = song.kotobagaki ? song.kotobagaki.trim() : '';

      if (!content && !kotobagaki) return;

      html += `<div class="v-song-group">`;
      if (kotobagaki) {
        html += `<div class="v-text v-kotobagaki">${renderRubyToHtml(kotobagaki)}</div>`;
      }
      if (content) {
        html += `<div class="v-text v-song-content">${renderRubyToHtml(content)}</div>`;
      }
      html += `</div>`;
    });

    elements.verticalPreviewContent.innerHTML = html;
  }

  // ==========================================================================
  // コピー
  // ==========================================================================
  async function copyLatexToClipboard() {
    const code = generateLatexCode();
    try {
      await navigator.clipboard.writeText(code);
      showToast('LaTeXコードをコピーしました');

      const copyIcon = elements.btnCopyLatex.querySelector('.icon-copy');
      const checkIcon = elements.btnCopyLatex.querySelector('.icon-check');
      if (copyIcon && checkIcon) {
        copyIcon.style.display = 'none';
        checkIcon.style.display = 'inline-block';
        setTimeout(() => {
          copyIcon.style.display = 'inline-block';
          checkIcon.style.display = 'none';
        }, 1500);
      }
    } catch (err) {
      fallbackCopy(code);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('LaTeXコードをコピーしました');
    } catch (err) {
      showToast('手動でコピーしてください');
    }
    document.body.removeChild(ta);
  }

  // ==========================================================================
  // 確認モーダル & フォーカストラップ
  // ==========================================================================
  let confirmCallback = null;

  function showConfirmModal(message, onConfirm, triggerEl = null) {
    if (triggerEl) {
      lastTriggerElement = triggerEl;
    }
    elements.modalMessage.textContent = message;
    confirmCallback = onConfirm;
    elements.modalBackdrop.classList.add('open');
    if (elements.appLayout) elements.appLayout.setAttribute('aria-hidden', 'true');

    setTimeout(() => {
      elements.modalBtnCancel.focus();
    }, 50);
  }

  function hideConfirmModal() {
    elements.modalBackdrop.classList.remove('open');
    if (elements.appLayout) elements.appLayout.removeAttribute('aria-hidden');
    confirmCallback = null;

    if (lastTriggerElement && typeof lastTriggerElement.focus === 'function') {
      lastTriggerElement.focus();
    }
  }

  elements.modalBtnCancel.addEventListener('click', hideConfirmModal);
  elements.modalBtnConfirm.addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    hideConfirmModal();
  });
  elements.modalBackdrop.addEventListener('click', (e) => {
    if (e.target === elements.modalBackdrop) hideConfirmModal();
  });

  // モーダル内フォーカストラップ
  function setupFocusTrap(modalBackdrop) {
    modalBackdrop.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;

      const focusables = modalBackdrop.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  // ==========================================================================
  // モバイル画面切替
  // ==========================================================================
  function switchMobileTab(tab) {
    document.body.setAttribute('data-mobile-tab', tab);
    elements.mobileNavTabs.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
  }

  // ==========================================================================
  // 初期化
  // ==========================================================================
  function init() {
    loadFromStorage();

    elements.rensakuTitleInput.value = state.title;
    elements.rensakuAuthorInput.value = state.author;

    let isComposingTitle = false;
    let isComposingAuthor = false;

    elements.rensakuTitleInput.addEventListener('compositionstart', () => { isComposingTitle = true; });
    elements.rensakuTitleInput.addEventListener('compositionend', (e) => {
      isComposingTitle = false;
      state.title = e.target.value;
      saveToStorage();
      requestPreviewUpdate();
    });
    elements.rensakuTitleInput.addEventListener('input', (e) => {
      state.title = e.target.value;
      saveToStorage();
      if (!isComposingTitle) {
        requestPreviewUpdate();
      }
    });

    elements.rensakuAuthorInput.addEventListener('compositionstart', () => { isComposingAuthor = true; });
    elements.rensakuAuthorInput.addEventListener('compositionend', (e) => {
      isComposingAuthor = false;
      state.author = e.target.value;
      saveToStorage();
      requestPreviewUpdate();
    });
    elements.rensakuAuthorInput.addEventListener('input', (e) => {
      state.author = e.target.value;
      saveToStorage();
      if (!isComposingAuthor) {
        requestPreviewUpdate();
      }
    });

    elements.addSongBtn.addEventListener('click', addNewSong);

    // 入力内容の全消去
    elements.clearAllBtn.addEventListener('click', () => {
      showConfirmModal('すべての入力を消去しますか？', () => {
        state = createInitialState();
        elements.rensakuTitleInput.value = '';
        elements.rensakuAuthorInput.value = '';
        saveToStorage();
        renderSongCards();
        requestPreviewUpdate();
        showToast('消去しました');
      }, elements.clearAllBtn);
    });

    elements.mobileNavTabs.forEach(btn => {
      btn.addEventListener('click', () => switchMobileTab(btn.dataset.tab));
    });
    document.body.setAttribute('data-mobile-tab', 'form');

    elements.btnCopyLatex.addEventListener('click', copyLatexToClipboard);

    // ルビモーダル制御
    elements.rubyModalBtnClose.addEventListener('click', closeRubyModal);
    elements.rubyApplyBtn.addEventListener('click', applyRubyInModal);
    elements.rubySaveBtn.addEventListener('click', saveRubyModalResult);

    elements.rubyTargetContentBtn.addEventListener('click', () => switchRubyModalField('content'));
    elements.rubyTargetKotobagakiBtn.addEventListener('click', () => switchRubyModalField('kotobagaki'));

    elements.rubyReadingInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyRubyInModal();
      }
    });

    // フォーカストラップ設定
    setupFocusTrap(elements.rubyModalBackdrop);
    setupFocusTrap(elements.modalBackdrop);

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveToStorage();
        showToast('保存済');
      }
      if (e.key === 'Escape') {
        if (elements.rubyModalBackdrop.classList.contains('open')) {
          closeRubyModal();
        } else if (elements.modalBackdrop.classList.contains('open')) {
          hideConfirmModal();
        }
      }
    });

    renderSongCards();
    updatePreview();

    // マウスホイールによる縦書き横スクロール
    elements.paperScrollContainer.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        elements.paperScrollContainer.scrollLeft -= e.deltaY;
      }
    }, { passive: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
